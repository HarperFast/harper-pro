/**
 * Turns a fetched run directory (runs/<run-id>/<pair>/…) into report.md plus one SVG chart per
 * workload. Definitions used throughout:
 * - memory: the cell's container memory.max; ratio = memory / on-disk dataset (SST + blob bytes).
 * - reads per 1k: data-disk reads per completed request × 1000, i.e. reads/s per 1,000 req/s.
 * - extra: minus the same quantity in the unconstrained calibration of that workload and skew.
 * - knee: the largest memory step whose p99 is at least KNEE_FACTOR × the series' lowest p99.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const GiB = 1024 ** 3;
export const KNEE_FACTOR = 2;
/** A calibration reading more than this from disk did not hold the dataset in memory, so it is no baseline. */
export const IN_MEMORY_READS_PER_1K = 1;

export interface Row {
	pair: string;
	workload: string;
	skew: string;
	label: string;
	step: number;
	pinned: boolean;
	repeat: boolean;
	memoryGiB: number;
	dataGiB: number;
	ratio: number;
	offeredPerSec: number;
	okPerSec: number;
	lossPct: number;
	readsPerSec: number;
	/** Disk reads/s in the second half of the window relative to the first, in percent; shows unfinished warm-up. */
	readsDriftPct: number | null;
	readsPer1k: number;
	/** Null when the workload and skew have no valid unconstrained calibration to subtract. */
	extraReadsPer1k: number | null;
	extraReadsPerSec: number | null;
	readMBPerSec: number;
	readLatencyMs: number | null;
	dataHitPct: number | null;
	majorFaultsPerSec: number;
	/** The container's reads on every device; null for results recorded before it was measured. */
	allDeviceReadsPerSec: number | null;
	allDeviceReadMBPerSec: number | null;
	/** Container anonymous and page-cache memory at the end of the window. */
	anonGiB: number | null;
	pageCacheGiB: number | null;
	p50Ms: number | null;
	p99Ms: number | null;
	p999Ms: number | null;
	cpuMsPerReq: number;
	memorySomePct: number;
	ioSomePct: number;
	saturated: boolean;
	/** server-ctl.sh's readiness timeout when the instance stayed up and never answered: a saturated cell that served nothing. */
	notReady: string | null;
	clientLimited: boolean;
	valid: boolean;
	invalidReasons: string[];
}

export interface PairData {
	name: string;
	dataset: any;
	fio: any;
	calibrations: any[];
	cells: any[];
	/** Cell ids the pair's plan scheduled; empty when the plan was not saved with the results. */
	plannedCellIds: string[];
}

function readsPerRequest(serverWindow: any, okPerSec: number): number {
	return okPerSec > 0 ? serverWindow.disk.readsPerSec / okPerSec : 0;
}

export function cellRow(cell: any, calibration: any, dataset: any, pair: string): Row {
	const policy = cell.cell.policy;
	const dataBytes: number = dataset.dataBytes;
	const base = {
		pair,
		workload: cell.cell.workload,
		skew: cell.cell.skew,
		label: policy.label,
		step: policy.step,
		pinned: policy.label.endsWith('pinned'),
		repeat: cell.cell.id.endsWith('-repeat'),
		memoryGiB: policy.memoryMaxBytes / GiB,
		dataGiB: dataBytes / GiB,
		ratio: policy.memoryMaxBytes / dataBytes,
		offeredPerSec: cell.offeredRatePerSec,
	};
	if (!cell.client || !cell.server) {
		// An outcome of the policy, not a failed measurement; server-ctl.sh reports an exit during startup separately.
		const notReady: string | null =
			(cell.invalidReasons ?? []).join('\n').match(/^.* not ready after \d+ s$/m)?.[0] ?? null;
		return {
			...base,
			okPerSec: 0,
			lossPct: 100,
			readsPerSec: 0,
			readsDriftPct: null,
			readsPer1k: 0,
			extraReadsPer1k: null,
			extraReadsPerSec: null,
			readMBPerSec: 0,
			readLatencyMs: null,
			dataHitPct: null,
			majorFaultsPerSec: 0,
			allDeviceReadsPerSec: null,
			allDeviceReadMBPerSec: null,
			anonGiB: null,
			pageCacheGiB: null,
			p50Ms: null,
			p99Ms: null,
			p999Ms: null,
			cpuMsPerReq: 0,
			memorySomePct: 0,
			ioSomePct: 0,
			saturated: true,
			notReady,
			clientLimited: false,
			valid: notReady !== null,
			invalidReasons: notReady ? [] : (cell.invalidReasons ?? ['no measurements']),
		};
	}
	const measure = cell.client.measure;
	const window = cell.server.window;
	const okPerSec: number = measure.okPerSec;
	const readsPer1k = readsPerRequest(window, okPerSec) * 1000;
	const extraReadsPer1k = calibration
		? Math.max(0, readsPer1k - readsPerRequest(calibration.server.window, calibration.client.measure.okPerSec) * 1000)
		: null;
	return {
		...base,
		okPerSec,
		lossPct: measure.lossFraction * 100,
		readsPerSec: window.disk.readsPerSec,
		readsDriftPct: driftPct(cell.server.firstHalf?.disk.readsPerSec, cell.server.secondHalf?.disk.readsPerSec),
		readsPer1k,
		extraReadsPer1k,
		extraReadsPerSec: extraReadsPer1k === null ? null : (extraReadsPer1k * okPerSec) / 1000,
		readMBPerSec: window.disk.readBytesPerSec / 1e6,
		readLatencyMs: window.disk.meanReadLatencyMs,
		dataHitPct: cell.server.blockCache?.dataHitRate == null ? null : cell.server.blockCache.dataHitRate * 100,
		majorFaultsPerSec: window.majorFaultsPerSec,
		allDeviceReadsPerSec: window.cgroupIoAllDevices?.readsPerSec ?? null,
		allDeviceReadMBPerSec: window.cgroupIoAllDevices ? window.cgroupIoAllDevices.readBytesPerSec / 1e6 : null,
		anonGiB: window.memoryEnd ? window.memoryEnd.anonBytes / GiB : null,
		pageCacheGiB: window.memoryEnd ? window.memoryEnd.fileBytes / GiB : null,
		p50Ms: measure.latencySummary.p50Ms,
		p99Ms: measure.latencySummary.p99Ms,
		p999Ms: measure.latencySummary.p999Ms,
		cpuMsPerReq: okPerSec > 0 ? (window.cpuCores * 1000) / okPerSec : 0,
		memorySomePct: window.psi.memorySomePct,
		ioSomePct: window.psi.ioSomePct,
		saturated: cell.saturated,
		notReady: null,
		clientLimited: cell.clientLimited,
		valid: cell.valid,
		invalidReasons: cell.invalidReasons,
	};
}

function driftPct(first: number | undefined, second: number | undefined): number | null {
	if (first === undefined || second === undefined || first < 10) return null;
	return ((second - first) / first) * 100;
}

export function seriesKey(row: Row): string {
	return `${row.pair} ${row.workload} ${row.skew}`;
}

/** The curve's points, largest memory first. A client-limited cell measured the load generator, not Harper. */
export function curve(rows: Row[]): Row[] {
	return rows
		.filter((row) => row.valid && !row.clientLimited && !row.pinned && !row.repeat)
		.sort((a, b) => b.memoryGiB - a.memoryGiB);
}

/** Extra reads/s where an in-memory baseline exists, otherwise total data-disk reads/s. */
function plotted(row: Row): number {
	return row.extraReadsPerSec ?? row.readsPerSec;
}

export interface Knee {
	description: string;
	memoryGiB: number | null;
	ratio: number | null;
}

export function knee(series: Row[]): Knee {
	const points = curve(series).filter((row) => row.p99Ms !== null || row.saturated);
	if (points.length === 0) return { description: 'no valid cells', memoryGiB: null, ratio: null };
	if (points[0].saturated)
		return {
			description: `saturated already at ${fmt(points[0].memoryGiB)} GB`,
			memoryGiB: points[0].memoryGiB,
			ratio: points[0].ratio,
		};
	const baseline = Math.min(...points.filter((row) => !row.saturated).map((row) => row.p99Ms!));
	const hit = points.find((row) => row.saturated || row.p99Ms! >= KNEE_FACTOR * baseline);
	if (!hit)
		return { description: `not reached down to ${fmt(points.at(-1)!.memoryGiB)} GB`, memoryGiB: null, ratio: null };
	const latency = hit.p99Ms === null ? 'no request completed' : `p99 ${fmt(hit.p99Ms)} ms vs ${fmt(baseline)} ms`;
	const outcome = hit.notReady
		? 'did not start'
		: `${latency}${hit.saturated ? `, saturated (${fmt(servedPct(hit), 1)}% served)` : ''}`;
	return {
		description: `${fmt(hit.memoryGiB)} GB (memory/data ${fmt(hit.ratio)}): ${outcome}`,
		memoryGiB: hit.memoryGiB,
		ratio: hit.ratio,
	};
}

export interface Slope {
	pair: string;
	workload: string;
	skew: string;
	fromGiB: number;
	toGiB: number;
	dataToMemory: number;
	extraReadsPerGiBPer1k: number;
}

/**
 * Extra reads/s per GiB of memory removed, per 1,000 req/s, between adjacent unsaturated curve points;
 * a saturated cell measured a server that stopped serving the offered load. The series' baseline cancels
 * in the difference, so a series without one still has slopes.
 */
export function slopes(series: Row[]): Slope[] {
	const points = curve(series).filter((row) => !row.saturated);
	const result: Slope[] = [];
	for (let i = 1; i < points.length; i++) {
		const higher = points[i - 1];
		const lower = points[i];
		result.push({
			pair: lower.pair,
			workload: lower.workload,
			skew: lower.skew,
			fromGiB: higher.memoryGiB,
			toGiB: lower.memoryGiB,
			dataToMemory: lower.dataGiB / ((higher.memoryGiB + lower.memoryGiB) / 2),
			extraReadsPerGiBPer1k: (lower.readsPer1k - higher.readsPer1k) / (higher.memoryGiB - lower.memoryGiB),
		});
	}
	return result;
}

export function servedPct(row: Row): number {
	return row.offeredPerSec > 0 ? (row.okPerSec / row.offeredPerSec) * 100 : 0;
}

export function fmt(value: number | null | undefined, digits?: number): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return '–';
	const abs = Math.abs(value);
	const places = digits ?? (abs >= 100 ? 0 : abs >= 10 ? 1 : 2);
	return value.toFixed(places);
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const k = key(item);
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k)!.push(item);
	}
	return groups;
}

const SKEW_ORDER = ['uniform', 'zipf-0.8', 'zipf-1', 'zipf-1.2'];
const PALETTE = ['#4269d0', '#efb118', '#ff725c', '#6cc5b0', '#a463f2', '#97bbf5'];

function skewIndex(skew: string): number {
	const index = SKEW_ORDER.indexOf(skew);
	return index < 0 ? SKEW_ORDER.length : index;
}

export function fioSummary(fio: any): { iops: number | null; qd1LatencyMs: number | null; qd1P99Ms: number | null } {
	const read = (run: any) => run?.jobs?.[0]?.read;
	const deep = read(fio?.qd256);
	const shallow = read(fio?.qd1);
	return {
		iops: deep?.iops ?? null,
		qd1LatencyMs: shallow?.lat_ns?.mean ? shallow.lat_ns.mean / 1e6 : null,
		qd1P99Ms: shallow?.clat_ns?.percentile?.['99.000000'] ? shallow.clat_ns.percentile['99.000000'] / 1e6 : null,
	};
}

/** A Mermaid xychart of extra disk reads/s against memory/data, one line per skew. */
export function mermaidChart(pair: string, workload: string, rows: Row[]): string | null {
	const stalled = curve(rows).filter((row) => row.saturated);
	const stalledRatios = new Set(stalled.map((row) => fmt(row.ratio, 2)));
	const points = curve(rows).filter((row) => !row.saturated && !stalledRatios.has(fmt(row.ratio, 2)));
	const noBaseline = [...new Set(points.filter((row) => row.extraReadsPer1k === null).map((row) => row.skew))];
	const ratios = [...new Set(points.map((row) => fmt(row.ratio, 2)))];
	const bySkew = groupBy(points, (row) => row.skew);
	// xychart has no gaps: a skew missing any step is left out rather than drawn through a fake zero.
	const allSkews = [...bySkew.keys()].sort((a, b) => skewIndex(a) - skewIndex(b));
	const skews = allSkews.filter((skew) => bySkew.get(skew)!.length === ratios.length);
	const omitted = allSkews.filter((skew) => !skews.includes(skew));
	if (skews.length === 0) return null;
	const lines = skews.map((skew) => {
		const byRatio = new Map(bySkew.get(skew)!.map((row) => [fmt(row.ratio, 2), plotted(row)]));
		return `    line [${ratios.map((ratio) => fmt(byRatio.get(ratio)!, 1)).join(', ')}]`;
	});
	const max = Math.max(1, ...points.map(plotted));
	const legend =
		skews.map((skew, i) => `${skew} = ${PALETTE[i]}`).join(', ') +
		(omitted.length > 0 ? `; not drawn (missing cells): ${omitted.join(', ')}` : '') +
		(stalled.length > 0
			? `; steps cut because a cell saturated: ${stalled.map((row) => `${row.skew} at ${fmt(row.ratio, 2)}`).join(', ')}`
			: '') +
		(noBaseline.length > 0 ? `; total reads/s, no in-memory baseline: ${noBaseline.join(', ')}` : '');
	return [
		'```mermaid',
		`%%{init: {"themeVariables": {"xyChart": {"plotColorPalette": "${skews.map((_, i) => PALETTE[i]).join(', ')}"}}}}%%`,
		'xychart-beta',
		`    title "${pair} workload ${workload}: extra disk reads/s"`,
		`    x-axis "memory / data" [${ratios.map((ratio) => `"${ratio}"`).join(', ')}]`,
		`    y-axis "extra reads/s" 0 --> ${Math.ceil(max * 1.1)}`,
		...lines,
		'```',
		`<sub>Lines: ${legend}.</sub>`,
	].join('\n');
}

/**
 * SVG chart for one workload: extra disk reads/s against memory / data, both on log scales (y as
 * log10(1 + reads/s), so cells with no extra reads still plot), with the measured disk ceiling.
 */
export function svgChart(workload: string, rows: Row[], ceilingIops: number | null): string {
	const points = curve(rows.filter((row) => row.workload === workload));
	const width = 900;
	const height = 520;
	const margin = { left: 70, right: 230, top: 40, bottom: 60 };
	const plotWidth = width - margin.left - margin.right;
	const plotHeight = height - margin.top - margin.bottom;
	const ratios = points.map((row) => row.ratio);
	const minX = Math.log10(Math.min(...ratios, 1) * 0.8);
	const maxX = Math.log10(Math.max(...ratios, 1) * 1.25);
	const maxY =
		Math.log10(1 + Math.max(10, ceilingIops ?? 0, ...points.filter((row) => !row.saturated).map(plotted))) * 1.05;
	const x = (ratio: number) => margin.left + ((Math.log10(ratio) - minX) / (maxX - minX)) * plotWidth;
	const y = (value: number) => margin.top + plotHeight - (Math.log10(1 + Math.max(0, value)) / maxY) * plotHeight;
	const pairs = [...new Set(points.map((row) => row.pair))];
	const dashes = ['', '6 4', '2 3', '10 3 2 3'];
	const parts: string[] = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="sans-serif" font-size="12">`,
		`<rect width="${width}" height="${height}" fill="white"/>`,
		`<text x="${margin.left}" y="24" font-size="15" font-weight="bold">Workload ${workload}: extra disk reads/s vs memory / data size</text>`,
		`<line x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${margin.left + plotWidth}" y2="${margin.top + plotHeight}" stroke="#333"/>`,
		`<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotHeight}" stroke="#333"/>`,
		`<text x="${margin.left + plotWidth / 2}" y="${height - 15}" text-anchor="middle">container memory limit / on-disk data size (log scale)</text>`,
		`<text transform="translate(18 ${margin.top + plotHeight / 2}) rotate(-90)" text-anchor="middle">extra disk reads/s (log scale)</text>`,
	];
	for (const tick of [0.0625, 0.125, 0.25, 0.5, 1, 2]) {
		if (Math.log10(tick) < minX || Math.log10(tick) > maxX) continue;
		parts.push(
			`<line x1="${x(tick)}" y1="${margin.top}" x2="${x(tick)}" y2="${margin.top + plotHeight}" stroke="#eee"/>`,
			`<text x="${x(tick)}" y="${margin.top + plotHeight + 18}" text-anchor="middle">${tick}</text>`
		);
	}
	for (const tick of [0, 10, 100, 1000, 10000, 100000]) {
		if (Math.log10(1 + tick) > maxY) break;
		parts.push(
			`<line x1="${margin.left}" y1="${y(tick)}" x2="${margin.left + plotWidth}" y2="${y(tick)}" stroke="#eee"/>`,
			`<text x="${margin.left - 8}" y="${y(tick) + 4}" text-anchor="end">${tick.toLocaleString('en-US')}</text>`
		);
	}
	if (ceilingIops) {
		parts.push(
			`<line x1="${margin.left}" y1="${y(ceilingIops)}" x2="${margin.left + plotWidth}" y2="${y(ceilingIops)}" stroke="#888" stroke-dasharray="4 4"/>`,
			`<text x="${margin.left + plotWidth - 6}" y="${y(ceilingIops) - 6}" text-anchor="end" fill="#555">disk ceiling ${fmt(ceilingIops, 0)} IOPS (fio, 4 KiB random read)</text>`
		);
	}
	let legendY = margin.top;
	for (const [key, series] of groupBy(points, seriesKey)) {
		const { pair, skew } = series[0];
		const color = PALETTE[skewIndex(skew) % PALETTE.length];
		const dash = dashes[pairs.indexOf(pair) % dashes.length];
		const served = series.filter((row) => !row.saturated);
		const path = served
			.map((row, i) => `${i === 0 ? 'M' : 'L'}${x(row.ratio).toFixed(1)},${y(plotted(row)).toFixed(1)}`)
			.join(' ');
		parts.push(`<path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="${dash}"/>`);
		for (const row of served) {
			parts.push(
				`<circle cx="${x(row.ratio).toFixed(1)}" cy="${y(plotted(row)).toFixed(1)}" r="3" fill="${row.extraReadsPerSec === null ? 'white' : color}" stroke="${color}"/>`
			);
		}
		for (const row of series.filter((row) => row.saturated)) {
			const cx = x(row.ratio);
			const cy = margin.top + 6;
			parts.push(
				`<path d="M${(cx - 5).toFixed(1)},${cy - 5} L${(cx + 5).toFixed(1)},${cy + 5} M${(cx - 5).toFixed(1)},${cy + 5} L${(cx + 5).toFixed(1)},${cy - 5}" stroke="${color}" stroke-width="2"/>`
			);
		}
		parts.push(
			`<line x1="${width - margin.right + 15}" y1="${legendY}" x2="${width - margin.right + 45}" y2="${legendY}" stroke="${color}" stroke-width="2" stroke-dasharray="${dash}"/>`,
			`<text x="${width - margin.right + 52}" y="${legendY + 4}">${key.replace(` ${workload} `, ' ')}</text>`
		);
		legendY += 18;
	}
	parts.push(
		`<text x="${width - margin.right + 15}" y="${legendY + 14}" fill="#555">× on top edge = saturated cell</text>`,
		`<text x="${width - margin.right + 15}" y="${legendY + 30}" fill="#555">hollow = total reads/s (no in-memory</text>`,
		`<text x="${width - margin.right + 15}" y="${legendY + 44}" fill="#555">baseline to subtract)</text>`,
		'</svg>'
	);
	return parts.join('\n');
}

export async function loadPair(dir: string, name: string): Promise<PairData> {
	const readJSON = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
	const readAll = async (sub: string) => {
		const path = join(dir, sub);
		if (!existsSync(path)) return [];
		const files = (await readdir(path)).filter((file) => file.endsWith('.json')).sort();
		return Promise.all(files.map((file) => readJSON(join(path, file))));
	};
	return {
		name,
		dataset: await readJSON(join(dir, 'dataset.json')),
		fio: existsSync(join(dir, 'fio.json')) ? await readJSON(join(dir, 'fio.json')) : null,
		calibrations: await readAll('calibration'),
		cells: await readAll('cells'),
		plannedCellIds: existsSync(join(dir, 'plan.json'))
			? (await readJSON(join(dir, 'plan.json'))).pair.cells.map((cell: { id: string }) => cell.id)
			: [],
	};
}

export function pairRows(pair: PairData): Row[] {
	// A calibration whose window failed its checks, or whose dataset did not fit in memory, is no baseline.
	const valid = pair.calibrations.filter(
		(c) =>
			(c.server?.window?.invalidReasons ?? []).length === 0 &&
			readsPerRequest(c.server.window, c.client.measure.okPerSec) * 1000 <= IN_MEMORY_READS_PER_1K
	);
	const calibration = new Map(valid.map((c) => [`${c.workload}/${c.skew}`, c]));
	return pair.cells.map((cell) =>
		cellRow(cell, calibration.get(`${cell.cell.workload}/${cell.cell.skew}`), pair.dataset, pair.name)
	);
}

export function renderReport(
	pairs: PairData[],
	meta: { runId: string; harperCommit?: string }
): { markdown: string; charts: Record<string, string> } {
	const rows = pairs.flatMap(pairRows);
	const lines: string[] = [`# Memory-limit miss curve — run ${meta.runId}`, ''];
	lines.push('## Environment', '');
	lines.push(
		'| pair | records | record | on-disk data (SST + blob) | data / 6 GB | load rate | fio 4 KiB random read IOPS (QD 256) | fio QD1 mean / p99 read latency |'
	);
	lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
	for (const pair of pairs) {
		const fio = fioSummary(pair.fio);
		const { dataset } = pair;
		lines.push(
			`| ${pair.name} | ${dataset.records.toLocaleString('en-US')} | ${dataset.recordShape.fieldCount} × ${dataset.recordShape.fieldLength} B | ${fmt(dataset.dataBytes / GiB)} GiB | ${fmt(dataset.dataBytes / (6 * GiB))} | ${fmt(dataset.loadRecordsPerSec, 0)} rec/s | ${fmt(fio.iops, 0)} | ${fmt(fio.qd1LatencyMs)} / ${fmt(fio.qd1P99Ms)} ms |`
		);
	}
	if (meta.harperCommit) lines.push('', `Harper Pro commit \`${meta.harperCommit}\`.`);

	const steps = [...new Set(rows.filter((row) => !row.repeat).map((row) => row.label))].sort((a, b) => {
		const value = (label: string) => parseFloat(label) - (label.endsWith('pinned') ? 0.5 : 0);
		return value(b) - value(a);
	});
	lines.push('', '## Extra disk reads/s (p99 ms) at the offered rate', '');
	lines.push(`| pair | workload | skew | rate req/s | ${steps.join(' | ')} | p99 knee |`);
	lines.push(`| --- | --- | --- | --- | ${steps.map(() => '---').join(' | ')} | --- |`);
	const series = groupBy(
		rows.filter((row) => !row.repeat),
		seriesKey
	);
	const sortedSeries = [...series.values()].sort(
		(a, b) =>
			a[0].pair.localeCompare(b[0].pair) ||
			a[0].workload.localeCompare(b[0].workload) ||
			skewIndex(a[0].skew) - skewIndex(b[0].skew)
	);
	for (const group of sortedSeries) {
		const byLabel = new Map(group.map((row) => [row.label, row]));
		const cells = steps.map((label) => {
			const row = byLabel.get(label);
			if (!row) return '';
			if (!row.valid) return 'invalid';
			if (row.notReady) return '⚠ did not start';
			if (row.saturated)
				return `⚠ ${fmt(servedPct(row), 1)}% served (${fmt(row.p99Ms)})${row.clientLimited ? ' ‡' : ''}`;
			return `${row.extraReadsPerSec === null ? `${fmt(row.readsPerSec)} total` : fmt(row.extraReadsPerSec)} (${fmt(row.p99Ms)})${row.clientLimited ? ' ‡' : ''}`;
		});
		lines.push(
			`| ${group[0].pair} | ${group[0].workload} | ${group[0].skew} | ${fmt(group[0].offeredPerSec, 0)} | ${cells.join(' | ')} | ${knee(group).description} |`
		);
	}
	lines.push(
		'',
		`⚠ = saturated: more than 0.1% of scheduled requests shed or timed out, or under 99% of the offered rate completed; the cell shows the share of the offered rate served (p99 ms) instead of reads, and is left out of slopes. ⚠ did not start = the instance never answered a REST request within 600 s of starting under that limit; it counts as a saturated cell that served nothing. total = no in-memory baseline: the unconstrained calibration was invalid or read more than ${IN_MEMORY_READS_PER_1K} disk read per 1,000 requests (the dataset did not fit in the host's page cache), so the cell shows all data-disk reads/s. ‡ = client-limited (load-generator CPU above 85% or schedule lag p99 above 10 ms); left out of knees, slopes and charts. Knee: largest memory step whose p99 is ≥ ${KNEE_FACTOR}× the series' lowest p99, or that saturated.`
	);
	const missing = pairs.flatMap((pair) => {
		const present = new Set(pair.cells.map((cell) => cell.cell.id));
		return pair.plannedCellIds.filter((id) => !present.has(id)).map((id) => `${pair.name}/${id}`);
	});
	if (missing.length > 0) lines.push('', `**Cells with no result (${missing.length}):** ${missing.join(', ')}.`);

	lines.push('', '## Charts', '');
	for (const pair of pairs) {
		for (const workload of new Set(rows.filter((row) => row.pair === pair.name).map((row) => row.workload))) {
			const chart = mermaidChart(
				pair.name,
				workload,
				rows.filter((row) => row.pair === pair.name && row.workload === workload)
			);
			if (chart) lines.push(chart, '');
		}
	}

	lines.push('## Extra reads/s per GB of memory removed, per 1,000 req/s', '');
	lines.push('| data / memory | pair | workload | skew | memory step | extra reads/s per GiB removed per 1k req/s |');
	lines.push('| --- | --- | --- | --- | --- | --- |');
	const allSlopes = [...series.values()].flatMap(slopes).sort((a, b) => a.dataToMemory - b.dataToMemory);
	for (const slope of allSlopes) {
		lines.push(
			`| ${fmt(slope.dataToMemory)} | ${slope.pair} | ${slope.workload} | ${slope.skew} | ${fmt(slope.fromGiB)} → ${fmt(slope.toGiB)} GB | ${fmt(slope.extraReadsPerGiBPer1k)} |`
		);
	}

	const pinnedRows = rows.filter((row) => row.pinned && row.valid && !row.clientLimited);
	if (pinnedRows.length > 0) {
		lines.push('', '## Block cache vs page cache (50% step, block cache pinned to the 100% size)', '');
		lines.push(
			'| pair | workload | skew | disk reads/1k at 100% | at 50% | at 50% pinned | share of the 100→50% increase removed by pinning | p99 50% / pinned |'
		);
		lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
		for (const pinned of pinnedRows) {
			const group = series.get(seriesKey(pinned)) ?? [];
			const served = curve(group).filter((row) => !row.saturated);
			const full = served.find((row) => row.step === 1);
			const half = served.find((row) => row.step === pinned.step);
			const control = pinned.saturated ? undefined : pinned;
			// Raw reads: the baseline cancels in this ratio, so a series without one still gets a share.
			const increase = full && half ? half.readsPer1k - full.readsPer1k : null;
			const share =
				increase && increase > 0 && half && control ? (half.readsPer1k - control.readsPer1k) / increase : null;
			const reads = (row: Row | undefined) => fmt(row?.readsPer1k);
			const controlCell = pinned.notReady
				? '⚠ did not start'
				: pinned.saturated
					? `⚠ ${fmt(servedPct(pinned), 1)}% served`
					: reads(pinned);
			lines.push(
				`| ${pinned.pair} | ${pinned.workload} | ${pinned.skew} | ${reads(full)} | ${reads(half)} | ${controlCell} | ${share === null ? '–' : `${fmt(share * 100, 0)}%`} | ${fmt(half?.p99Ms)} / ${fmt(pinned.p99Ms)} |`
			);
		}
	}

	const repeats = rows.filter((row) => row.repeat && row.valid);
	if (repeats.length > 0) {
		lines.push('', '## Repeat cells (run-to-run noise)', '');
		lines.push('| pair | cell | extra reads/1k first / repeat | p99 ms first / repeat |');
		lines.push('| --- | --- | --- | --- |');
		for (const repeat of repeats) {
			const first = rows.find(
				(row) => !row.repeat && seriesKey(row) === seriesKey(repeat) && row.label === repeat.label
			);
			lines.push(
				`| ${repeat.pair} | ${repeat.workload} ${repeat.skew} ${repeat.label} | ${fmt(first?.extraReadsPer1k)} / ${fmt(repeat.extraReadsPer1k)} | ${fmt(first?.p99Ms)} / ${fmt(repeat.p99Ms)} |`
			);
		}
	}

	lines.push('', '<details><summary>All cells</summary>', '');
	lines.push(
		'| pair | workload | skew | step | mem GB | mem/data | offered | ok/s | loss % | disk reads/s | 2nd vs 1st half % | reads/1k | extra/1k | read MB/s | read await ms | block-cache data hit % | major faults/s | all-device reads/s | all-device read MB/s | anon GB | page cache GB | p50 | p99 | p99.9 ms | CPU ms/req | PSI mem some % | PSI io some % | valid |'
	);
	lines.push(`|${' --- |'.repeat(28)}`);
	for (const row of [...rows].sort((a, b) => seriesKey(a).localeCompare(seriesKey(b)) || b.memoryGiB - a.memoryGiB)) {
		lines.push(
			`| ${row.pair} | ${row.workload} | ${row.skew} | ${row.label}${row.repeat ? ' (repeat)' : ''} | ${fmt(row.memoryGiB)} | ${fmt(row.ratio)} | ${fmt(row.offeredPerSec, 0)} | ${fmt(row.okPerSec, 0)} | ${fmt(row.lossPct)} | ${fmt(row.readsPerSec, 0)} | ${fmt(row.readsDriftPct, 0)} | ${fmt(row.readsPer1k)} | ${fmt(row.extraReadsPer1k)} | ${fmt(row.readMBPerSec)} | ${fmt(row.readLatencyMs)} | ${fmt(row.dataHitPct, 1)} | ${fmt(row.majorFaultsPerSec)} | ${fmt(row.allDeviceReadsPerSec, 0)} | ${fmt(row.allDeviceReadMBPerSec)} | ${fmt(row.anonGiB)} | ${fmt(row.pageCacheGiB)} | ${fmt(row.p50Ms)} | ${fmt(row.p99Ms)} | ${fmt(row.p999Ms)} | ${fmt(row.cpuMsPerReq, 3)} | ${fmt(row.memorySomePct)} | ${fmt(row.ioSomePct)} | ${row.notReady ? `did not start: ${row.notReady}` : row.valid ? (row.clientLimited ? 'client-limited' : 'yes') : `no: ${row.invalidReasons.join('; ').replace(/\|/g, '/')}`} |`
		);
	}
	lines.push('', '</details>');

	const charts: Record<string, string> = {};
	const ceilings = pairs.map((pair) => fioSummary(pair.fio).iops).filter((iops): iops is number => iops !== null);
	const ceiling = ceilings.length > 0 ? Math.min(...ceilings) : null;
	for (const workload of new Set(rows.map((row) => row.workload))) {
		charts[`chart-${workload}.svg`] = svgChart(workload, rows, ceiling);
	}
	return { markdown: lines.join('\n') + '\n', charts };
}

export async function writeReport(runDir: string): Promise<string> {
	const entries = await readdir(runDir, { withFileTypes: true });
	const pairs: PairData[] = [];
	for (const entry of entries) {
		if (entry.isDirectory() && existsSync(join(runDir, entry.name, 'dataset.json')))
			pairs.push(await loadPair(join(runDir, entry.name), entry.name));
	}
	if (pairs.length === 0) throw new Error(`no pair results under ${runDir}`);
	const manifestFile = join(runDir, 'manifest.json');
	const manifest = existsSync(manifestFile) ? JSON.parse(await readFile(manifestFile, 'utf8')) : {};
	const { markdown, charts } = renderReport(pairs, {
		runId: manifest.runId ?? runDir,
		harperCommit: manifest.harperCommit,
	});
	for (const [name, svg] of Object.entries(charts)) await writeFile(join(runDir, name), svg);
	const file = join(runDir, 'report.md');
	await writeFile(file, markdown);
	return file;
}

if (import.meta.main) {
	const { positionals } = parseArgs({ allowPositionals: true });
	if (!positionals[0]) throw new Error('usage: report.mts <run directory>');
	console.log(await writeReport(positionals[0]));
}
