/**
 * Gate for the YCSB cluster-nightly publish steps. Trend points are only comparable when every
 * run measured the same CPU clock, and the bench runner pins it by turning turbo off for each
 * job (see runner/README.md). This reads the host CPU state from sysfs and only allows publishing
 * when turbo is off AND every online CPU's scaling_max_freq equals its base_frequency; the second
 * check also catches a leftover `cpupower frequency-set -u` cap below base.
 *
 *   node benchmarks/ycsb/check-cpu-pinned.mts <state.json>
 *
 * Writes the state to <state.json> and the job summary, and `pinned=true|false` to
 * $GITHUB_OUTPUT. When not pinned it emits a warning annotation and still exits 0, so the run
 * stays visible but off the trend. SYSFS_ROOT (default /sys) points at a fake tree in tests.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

interface CpuState {
	cpu: number;
	scalingMaxFreq: number | null;
	baseFrequency: number | null;
}

const cpuRoot = join(process.env.SYSFS_ROOT ?? '/sys', 'devices/system/cpu');

async function readNumber(path: string): Promise<number | null> {
	try {
		const value = Number((await readFile(path, 'utf8')).trim());
		return Number.isFinite(value) ? value : null;
	} catch {
		return null;
	}
}

/** Parses a sysfs CPU list such as `0-3,6,8-11`. */
function parseCpuList(list: string): number[] {
	const cpus: number[] = [];
	for (const range of list.trim().split(',').filter(Boolean)) {
		const [start, end = start] = range.split('-').map(Number);
		for (let cpu = start; cpu <= end; cpu++) cpus.push(cpu);
	}
	return cpus;
}

async function main(): Promise<void> {
	const [statePath] = process.argv.slice(2);
	if (!statePath) throw new Error('usage: check-cpu-pinned.mts <state.json>');

	const noTurbo = await readNumber(join(cpuRoot, 'intel_pstate/no_turbo'));
	let online: number[] = [];
	try {
		online = parseCpuList(await readFile(join(cpuRoot, 'online'), 'utf8'));
	} catch {}
	const cpus: CpuState[] = await Promise.all(
		online.map(async (cpu) => ({
			cpu,
			scalingMaxFreq: await readNumber(join(cpuRoot, `cpu${cpu}/cpufreq/scaling_max_freq`)),
			baseFrequency: await readNumber(join(cpuRoot, `cpu${cpu}/cpufreq/base_frequency`)),
		}))
	);

	const reasons: string[] = [];
	if (noTurbo !== 1) reasons.push(`intel_pstate/no_turbo is ${noTurbo ?? 'unreadable'}, not 1`);
	if (cpus.length === 0) reasons.push('no online CPUs found');
	const unpinned = cpus.filter((c) => c.scalingMaxFreq === null || c.scalingMaxFreq !== c.baseFrequency);
	if (unpinned.length > 0) {
		reasons.push(
			`scaling_max_freq != base_frequency on ${unpinned
				.map((c) => `cpu${c.cpu} (${c.scalingMaxFreq ?? '?'} vs ${c.baseFrequency ?? '?'})`)
				.join(', ')}`
		);
	}
	const pinned = reasons.length === 0;

	await mkdir(dirname(statePath), { recursive: true });
	await writeFile(statePath, JSON.stringify({ pinned, reasons, noTurbo, cpus }, null, '\t') + '\n');

	const summaryPath = process.env.GITHUB_STEP_SUMMARY;
	if (summaryPath) {
		const rows = cpus.map((c) => `| ${c.cpu} | ${c.scalingMaxFreq ?? '?'} | ${c.baseFrequency ?? '?'} |`);
		await appendFile(
			summaryPath,
			[
				'### Host CPU state',
				'',
				`Pinned: **${pinned}** (intel_pstate/no_turbo = ${noTurbo ?? 'unreadable'})`,
				...reasons.map((reason) => `- ${reason}`),
				'',
				'| CPU | scaling_max_freq (kHz) | base_frequency (kHz) |',
				'| --- | --- | --- |',
				...rows,
				'',
			].join('\n')
		);
	}

	if (pinned) {
		console.log(`CPU pinned: turbo off and ${cpus.length} CPUs at base frequency. Publishing allowed.`);
	} else {
		console.log(
			`::warning::Skipping publish — host CPU was not pinned (${reasons.join('; ')}). ` +
				`The benchmark trend is left untouched.`
		);
	}
	const outputPath = process.env.GITHUB_OUTPUT;
	if (outputPath) await appendFile(outputPath, `pinned=${pinned}\n`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
