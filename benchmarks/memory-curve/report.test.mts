import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	cellRow,
	fioSummary,
	knee,
	mermaidChart,
	pairRows,
	renderReport,
	slopes,
	svgChart,
	type PairData,
} from './report.mts';
import { fabricPolicy, pinnedPolicy } from './matrix.mts';

const GiB = 1024 ** 3;
const dataset = {
	records: 1000,
	recordShape: { fieldCount: 10, fieldLength: 100 },
	dataBytes: 12 * GiB,
	loadRecordsPerSec: 5000,
};

function cell(
	step: number,
	readsPerSec: number,
	p99Ms: number,
	options: { pinned?: boolean; saturated?: boolean; valid?: boolean; skew?: string; clientLimited?: boolean } = {}
) {
	const policy = options.pinned ? pinnedPolicy(step, 6 * GiB) : fabricPolicy(`${step * 100}%`, step, 6 * GiB);
	const skew = options.skew ?? 'zipf-1';
	return {
		cell: { id: `C-${skew}-${policy.label}`.replace(/%/g, 'pct'), workload: 'C', skew, policy },
		offeredRatePerSec: 10_000,
		valid: options.valid ?? true,
		invalidReasons: options.valid === false ? ['container restarted during the window'] : [],
		saturated: options.saturated ?? false,
		clientLimited: options.clientLimited ?? false,
		client: { measure: { okPerSec: 10_000, lossFraction: 0, latencySummary: { p50Ms: 1, p99Ms, p999Ms: p99Ms * 2 } } },
		server: {
			window: {
				disk: { readsPerSec, readBytesPerSec: readsPerSec * 4096, meanReadLatencyMs: 1.2 },
				majorFaultsPerSec: 0,
				cpuCores: 2,
				psi: { memorySomePct: 1, ioSomePct: 5 },
			},
			blockCache: { dataHitRate: 0.5 },
		},
	};
}

function notReady(step: number) {
	return {
		cell: cell(step, 0, 0).cell,
		offeredRatePerSec: 10_000,
		valid: false,
		invalidReasons: ['cell failed: server-ctl start failed: Command failed: ssh …\nREST route not ready after 600 s'],
	};
}

const calibration = {
	workload: 'C',
	skew: 'zipf-1',
	client: { measure: { okPerSec: 20_000 } },
	server: { window: { disk: { readsPerSec: 20 } } },
};

describe('cellRow', () => {
	it('normalizes disk reads per 1,000 completed requests and subtracts the unconstrained baseline', () => {
		const row = cellRow(cell(0.5, 3000, 4), calibration, dataset, 'd2x-1k');
		assert.equal(row.readsPer1k, 300);
		assert.equal(row.extraReadsPer1k, 299);
		assert.equal(row.extraReadsPerSec, 2990);
		assert.equal(row.memoryGiB, 3);
		assert.equal(row.ratio, 0.25);
		assert.equal(row.cpuMsPerReq, 0.2);
		assert.equal(row.dataHitPct, 50);
	});

	it('keeps a failed cell as an invalid row', () => {
		const failed = {
			cell: cell(0.25, 0, 0).cell,
			offeredRatePerSec: 10_000,
			valid: false,
			invalidReasons: ['cell failed: OOM'],
		};
		const row = cellRow(failed, calibration, dataset, 'd2x-1k');
		assert.equal(row.valid, false);
		assert.deepEqual(row.invalidReasons, ['cell failed: OOM']);
	});

	it('keeps an instance that never became ready as a saturated cell that served nothing', () => {
		const row = cellRow(notReady(0.25), calibration, dataset, 'd2x-1k');
		assert.equal(row.valid, true);
		assert.equal(row.notReady, 'REST route not ready after 600 s');
		assert.equal(row.saturated, true);
		assert.equal(row.okPerSec, 0);
		const exited = cellRow(
			{
				...notReady(0.25),
				invalidReasons: ['cell failed: server-ctl start failed: Harper container exited during startup'],
			},
			calibration,
			dataset,
			'd2x-1k'
		);
		assert.equal(exited.valid, false);
	});
});

describe('knee and slopes', () => {
	const rows = [
		cellRow(cell(1, 100, 2), calibration, dataset, 'p'),
		cellRow(cell(0.7, 500, 2.5), calibration, dataset, 'p'),
		cellRow(cell(0.5, 1500, 4.5), calibration, dataset, 'p'),
		cellRow(cell(0.35, 4000, 30, { saturated: true }), calibration, dataset, 'p'),
		cellRow(cell(0.5, 900, 3, { pinned: true }), calibration, dataset, 'p'),
	];

	it('finds the largest step whose p99 doubles the lowest p99, ignoring the pinned cell', () => {
		const result = knee(rows);
		assert.equal(result.memoryGiB, 3);
		assert.match(result.description, /p99 4\.50 ms vs 2\.00 ms/);
	});

	it('leaves client-limited cells out of knees and slopes', () => {
		const limited = cellRow(cell(0.7, 500, 50, { clientLimited: true }), calibration, dataset, 'p');
		const series = [rows[0], limited, rows[2]];
		assert.equal(knee(series).memoryGiB, 3);
		assert.equal(slopes(series).length, 1);
	});

	it('reports a series saturated at its largest step, and one with no knee', () => {
		assert.match(
			knee([cellRow(cell(1, 100, 50, { saturated: true }), calibration, dataset, 'p')]).description,
			/saturated already/
		);
		assert.match(knee(rows.slice(0, 2)).description, /not reached/);
	});

	it('treats a saturated cell that completed no request as the knee', () => {
		const stalled = cellRow(cell(0.5, 0, 0, { saturated: true }), calibration, dataset, 'p');
		stalled.p99Ms = null;
		stalled.okPerSec = 0;
		const result = knee([rows[0], rows[1], stalled]);
		assert.equal(result.memoryGiB, 3);
		assert.match(result.description, /no request completed, saturated \(0\.0% served\)/);
	});

	it('treats an instance that never became ready as the knee', () => {
		const result = knee([rows[0], rows[1], cellRow(notReady(0.5), calibration, dataset, 'p')]);
		assert.equal(result.memoryGiB, 3);
		assert.match(result.description, /3\.00 GB \(memory\/data 0\.25\): did not start$/);
	});

	it('computes extra reads per GiB removed between adjacent unsaturated steps', () => {
		const result = slopes(rows);
		assert.equal(result.length, 2);
		const first = result[0];
		assert.equal(first.fromGiB, 6);
		assert.ok(Math.abs(first.toGiB - 4.2) < 0.01);
		// (500 - 100) reads/s per 10k req/s = 40 per 1k, over 1.8 GiB
		assert.ok(Math.abs(first.extraReadsPerGiBPer1k - 40 / 1.8) < 0.1, `${first.extraReadsPerGiBPer1k}`);
		assert.ok(Math.abs(result[1].toGiB - 3) < 0.01);
	});
});

describe('renderReport', () => {
	const pair: PairData = {
		name: 'd2x-1k',
		dataset,
		fio: {
			qd256: { jobs: [{ read: { iops: 5432.1 } }] },
			qd1: { jobs: [{ read: { lat_ns: { mean: 1_100_000 }, clat_ns: { percentile: { '99.000000': 2_500_000 } } } }] },
		},
		calibrations: [calibration, { ...calibration, skew: 'uniform' }],
		cells: [
			cell(1, 100, 2),
			cell(0.5, 1500, 4.5),
			cell(0.5, 900, 3, { pinned: true }),
			cell(1, 800, 3, { skew: 'uniform' }),
			cell(0.5, 5000, 40, { skew: 'uniform', saturated: true }),
			cell(0.25, 0, 0, { valid: false }),
		],
		plannedCellIds: ['C-zipf-1-100pct', 'C-zipf-1-50pct', 'C-zipf-1-35pct'],
	};

	it('produces every report section', () => {
		const { markdown, charts } = renderReport([pair], { runId: 'mctest', harperCommit: 'abc123' });
		for (const heading of [
			'## Environment',
			'## Extra disk reads/s',
			'## Charts',
			'## Extra reads/s per GB',
			'## Block cache vs page cache',
			'All cells',
		]) {
			assert.ok(markdown.includes(heading), `missing ${heading}`);
		}
		assert.match(markdown, /\| 5432 \|/);
		assert.match(markdown, /1\.10 \/ 2\.50 ms/);
		assert.match(markdown, /```mermaid/);
		assert.match(markdown, /invalid/);
		assert.match(markdown, /Cells with no result \(1\):\*\* d2x-1k\/C-zipf-1-35pct/);
		assert.ok(charts['chart-C.svg'].startsWith('<svg'));
		assert.match(charts['chart-C.svg'], /disk ceiling 5432 IOPS/);
		assert.match(markdown, /\| ⚠ 100\.0% served \(40\.0\) \|/);
		assert.match(markdown, /steps cut because a cell saturated: uniform at 0\.25/);
	});

	it('subtracts no baseline from a calibration whose window was invalid or that read from disk', () => {
		const invalidWindow = {
			...calibration,
			server: {
				window: { disk: { readsPerSec: 0 }, invalidReasons: ['server counters taken 90 s off the measured window'] },
			},
		};
		const onDisk = { ...calibration, server: { window: { disk: { readsPerSec: 5000 }, invalidReasons: [] } } };
		for (const badCalibration of [invalidWindow, onDisk]) {
			const withoutBaseline = { ...pair, calibrations: [badCalibration], cells: [cell(1, 100, 2), cell(0.5, 3000, 4)] };
			const rows = pairRows(withoutBaseline);
			assert.equal(rows[0].readsPer1k, 10);
			assert.equal(rows[0].extraReadsPer1k, null);
			// The baseline cancels in a slope: (300 - 10) reads per 1k over 3 GiB.
			assert.ok(Math.abs(slopes(rows)[0].extraReadsPerGiBPer1k - 290 / 3) < 0.01);
			const { markdown, charts } = renderReport([withoutBaseline], { runId: 'mctest' });
			assert.match(markdown, /\| 100 total \(2\.00\) \| 3000 total \(4\.00\) \|/);
			assert.match(markdown, /total reads\/s, no in-memory baseline: zipf-1/);
			assert.match(charts['chart-C.svg'], /<circle [^>]*fill="white"/);
		}
	});

	it('leaves a skew with a missing step out of the Mermaid chart instead of plotting a zero', () => {
		const rows = pairRows({
			...pair,
			cells: [cell(1, 100, 2), cell(0.5, 1500, 4.5), cell(1, 800, 3, { skew: 'uniform' })],
		});
		const chart = mermaidChart('d2x-1k', 'C', rows)!;
		assert.equal(chart.match(/^\s+line \[/gm)?.length, 1);
		assert.match(chart, /not drawn \(missing cells\): uniform/);
	});

	it('shows a cell whose instance never became ready as did not start', () => {
		const { markdown } = renderReport([{ ...pair, cells: [cell(1, 100, 2), cell(0.5, 1500, 3), notReady(0.25)] }], {
			runId: 'mctest',
		});
		assert.match(markdown, /\| ⚠ did not start \| 1\.50 GB \(memory\/data 0\.13\): did not start \|/);
		assert.match(markdown, /\| did not start: REST route not ready after 600 s \|\n/);
		assert.doesNotMatch(markdown, /no valid calibration baseline/);
	});

	it('gives a pinning share from raw reads when the series has no in-memory baseline', () => {
		const onDisk = { ...calibration, server: { window: { disk: { readsPerSec: 5000 }, invalidReasons: [] } } };
		const { markdown } = renderReport(
			[
				{
					...pair,
					calibrations: [onDisk],
					cells: [cell(1, 1000, 2), cell(0.5, 3000, 4.5), cell(0.5, 2000, 3, { pinned: true })],
				},
			],
			{ runId: 'mctest' }
		);
		// (300 - 200) of the (300 - 100) reads per 1k increase.
		assert.match(markdown, /\| 100 total \| 300 total \| 200 total \| 50% \|/);
	});

	it('gives no pinning share for a saturated pinned control', () => {
		const { markdown } = renderReport(
			[{ ...pair, cells: [cell(1, 100, 2), cell(0.5, 1500, 4.5), cell(0.5, 0, 0, { pinned: true, saturated: true })] }],
			{ runId: 'mctest' }
		);
		assert.match(markdown, /\| ⚠ 100\.0% served \| – \|/);
	});

	it('summarizes fio output and tolerates a missing run', () => {
		assert.deepEqual(fioSummary(null), { iops: null, qd1LatencyMs: null, qd1P99Ms: null });
		assert.equal(mermaidChart('p', 'C', []), null);
		assert.ok(svgChart('C', [], null).includes('</svg>'));
	});
});
