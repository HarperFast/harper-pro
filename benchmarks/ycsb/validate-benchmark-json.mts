/**
 * Gate for the YCSB cluster-nightly publish steps. A cancelled or early-dispatched
 * run can leave a stale or partial `throughput.json` on the self-hosted runner;
 * publishing it pollutes the github-action-benchmark trend with low partial points
 * that read as regressions. This validates that the converted throughput output
 * carries the FULL expected metric set before the publish steps run.
 *
 * Expected set: the `load` series plus one `workload <X>` series per requested
 * workload. Series names carry a description suffix (e.g. "workload A — Update
 * heavy (50% read / 50% update)"), so we match the `workload <X>` prefix, not an
 * exact name.
 *
 *   node benchmarks/ycsb/validate-benchmark-json.mts <throughput.json> <workloads-csv>
 *
 * On a complete set it writes `publish=true` to $GITHUB_OUTPUT and exits 0. On an
 * incomplete set it emits a GitHub warning annotation, writes `publish=false`, and
 * still exits 0 — leaving the trend untouched without failing the workflow (a
 * partial workload set can be an intentional manual dispatch).
 */
import { readFile, appendFile } from 'node:fs/promises';

interface BenchPoint {
	name: string;
}

async function setOutput(publish: boolean): Promise<void> {
	const outputPath = process.env.GITHUB_OUTPUT;
	if (outputPath) await appendFile(outputPath, `publish=${publish}\n`);
}

async function main(): Promise<void> {
	const [throughputPath, workloadsCsv] = process.argv.slice(2);
	if (!throughputPath || !workloadsCsv) {
		throw new Error('usage: validate-benchmark-json.mts <throughput.json> <workloads-csv>');
	}

	const expectedWorkloads = workloadsCsv
		.split(',')
		.map((w) => w.trim().toUpperCase())
		.filter(Boolean);

	let names: string[];
	try {
		const parsed = JSON.parse(await readFile(throughputPath, 'utf8'));
		if (!Array.isArray(parsed)) throw new Error('expected a JSON array of benchmark points');
		names = (parsed as BenchPoint[]).map((p) => p.name);
	} catch (error) {
		console.log(`::warning::Skipping publish — could not read ${throughputPath}: ${(error as Error).message}`);
		await setOutput(false);
		return;
	}

	const matchesWorkload = (name: string, workload: string): boolean =>
		name === `workload ${workload}` || name.startsWith(`workload ${workload} `);

	const hasLoad = names.some((name) => name === 'load' || name.startsWith('load '));
	const missing = expectedWorkloads.filter((workload) => !names.some((name) => matchesWorkload(name, workload)));
	// A `workload <X>` series that wasn't requested means we're looking at a stale superset file
	// (e.g. a cancelled subset dispatch left a prior full run's latest.json) — also a partial-publish
	// vector, so refuse it rather than publish someone else's data under this run's context.
	const unexpected = names.filter(
		(name) => name.startsWith('workload ') && !expectedWorkloads.some((workload) => matchesWorkload(name, workload))
	);

	if (!hasLoad || missing.length > 0 || unexpected.length > 0) {
		const reasons: string[] = [];
		if (!hasLoad) reasons.push('missing the load series');
		if (missing.length > 0) reasons.push(`missing workload(s) ${missing.join(', ')}`);
		if (unexpected.length > 0) reasons.push(`unexpected series ${unexpected.join(', ')}`);
		console.log(
			`::warning::Skipping publish — result set does not match the requested run (${reasons.join('; ')}). ` +
				`Expected load + workloads ${expectedWorkloads.join(', ')}; got ${names.length} series. ` +
				`The benchmark trend is left untouched.`
		);
		await setOutput(false);
		return;
	}

	console.log(
		`Result set complete: load + workloads ${expectedWorkloads.join(', ')} (${names.length} series). Publishing.`
	);
	await setOutput(true);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
