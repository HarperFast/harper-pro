/**
 * The experiment matrix: which VM pairs run, and the cells (memory policy × workload × skew) each
 * pair measures. Memory policies mirror how host-manager configures a Fabric instance with hard
 * limit H: block cache 15% of H, write-buffer manager 5% of H (src/controllers/instanceController.js),
 * memory.high H − 1 GB (src/helpers/container.js), which is 5/6 of H for the 6 GB starting limit and
 * is kept at that ratio for the smaller steps.
 */

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

export interface MemoryPolicy {
	label: string;
	/** Fraction of the starting limit; null for the unconstrained calibration. */
	step: number | null;
	memoryMaxBytes: number | null;
	memoryHighBytes: number | null;
	blockCacheBytes: number;
	writeBufferManagerBytes: number;
}

export interface CellPlan {
	id: string;
	workload: string;
	skew: string;
	policy: MemoryPolicy;
}

export interface Timing {
	warmupSec: number;
	measureSec: number;
	calibrateWarmupSec: number;
	calibrateMeasureSec: number;
}

export interface PairSpec {
	name: string;
	fieldCount: number;
	fieldLength: number;
	/** Target on-disk dataset size as a multiple of the starting memory limit. */
	dataMultiple: number;
	workloads: string[];
	skews: string[];
	steps: number[];
	/** Step at which to add the control cell with the block cache pinned to the 100% step's size. */
	pinnedStep: number | null;
	/** Extra copies of these cells, run last, to show run-to-run noise. */
	repeats: Array<{ workload: string; skew: string; step: number }>;
}

export interface ProfileSpec {
	startLimitBytes: number;
	rateFraction: number;
	timing: Timing;
	pairs: PairSpec[];
}

export interface PairPlan extends PairSpec {
	records: number;
	keyWidth: number;
	startLimitBytes: number;
	rateFraction: number;
	timing: Timing;
	calibrations: Array<{ workload: string; skew: string; policy: MemoryPolicy }>;
	cells: CellPlan[];
}

const SKEWS = ['uniform', 'zipf-0.8', 'zipf-1', 'zipf-1.2'];
const STEPS = [1, 0.7, 0.5, 0.35, 0.25];

export const PROFILES: Record<string, ProfileSpec> = {
	full: {
		startLimitBytes: 6 * GiB,
		rateFraction: 0.5,
		timing: { warmupSec: 600, measureSec: 600, calibrateWarmupSec: 120, calibrateMeasureSec: 120 },
		pairs: [
			...[1, 2, 4].map((dataMultiple) => ({
				name: `d${dataMultiple}x-1k`,
				fieldCount: 10,
				fieldLength: 100,
				dataMultiple,
				workloads: ['C', 'B'],
				skews: SKEWS,
				steps: STEPS,
				pinnedStep: 0.5,
				repeats: [
					{ workload: 'C', skew: 'zipf-1', step: 1 },
					{ workload: 'C', skew: 'zipf-1', step: 0.25 },
				],
			})),
			{
				name: 'd2x-4k',
				fieldCount: 10,
				fieldLength: 400,
				dataMultiple: 2,
				workloads: ['C', 'B'],
				skews: ['zipf-1'],
				steps: STEPS,
				pinnedStep: null,
				repeats: [],
			},
		],
	},
	smoke: {
		startLimitBytes: 6 * GiB,
		rateFraction: 0.5,
		timing: { warmupSec: 60, measureSec: 60, calibrateWarmupSec: 20, calibrateMeasureSec: 20 },
		pairs: [
			{
				name: 'smoke',
				fieldCount: 10,
				fieldLength: 100,
				dataMultiple: 0.25,
				workloads: ['C', 'B'],
				skews: ['zipf-1'],
				steps: [1, 0.25],
				pinnedStep: 0.5,
				repeats: [],
			},
		],
	},
};

function roundMiB(bytes: number): number {
	return Math.floor(bytes / MiB) * MiB;
}

/** The policy host-manager would apply to an instance whose hard limit is `memoryMaxBytes`. */
export function fabricPolicy(label: string, step: number, startLimitBytes: number): MemoryPolicy {
	const memoryMaxBytes = roundMiB(startLimitBytes * step);
	return {
		label,
		step,
		memoryMaxBytes,
		memoryHighBytes: roundMiB((memoryMaxBytes * 5) / 6),
		blockCacheBytes: Math.floor(memoryMaxBytes * 0.15),
		writeBufferManagerBytes: Math.floor(memoryMaxBytes * 0.05),
	};
}

/** The 100% instance's configuration with the cgroup limits lifted. */
export function unconstrainedPolicy(startLimitBytes: number): MemoryPolicy {
	const reference = fabricPolicy('unconstrained', 1, startLimitBytes);
	return { ...reference, step: null, memoryMaxBytes: null, memoryHighBytes: null };
}

/** The `step` instance with its block cache pinned to the 100% instance's size; everything else unchanged. */
export function pinnedPolicy(step: number, startLimitBytes: number): MemoryPolicy {
	return {
		...fabricPolicy(`${step * 100}%-pinned`, step, startLimitBytes),
		blockCacheBytes: fabricPolicy('100%', 1, startLimitBytes).blockCacheBytes,
	};
}

/**
 * Approximate on-disk bytes per record after compaction; measured 806 B for 10 × 100 B fields
 * (the random field text compresses by about a fifth). The report uses the measured size.
 */
export function estimatedRecordBytes(fieldCount: number, fieldLength: number): number {
	return Math.round(0.78 * fieldCount * fieldLength + 30);
}

export function planPair(pair: PairSpec, profile: ProfileSpec): PairPlan {
	const { startLimitBytes } = profile;
	const records = Math.ceil(
		(pair.dataMultiple * startLimitBytes) / estimatedRecordBytes(pair.fieldCount, pair.fieldLength)
	);
	const policies = pair.steps.map((step) => fabricPolicy(`${Math.round(step * 100)}%`, step, startLimitBytes));
	if (pair.pinnedStep !== null) policies.push(pinnedPolicy(pair.pinnedStep, startLimitBytes));
	const cellId = (workload: string, skew: string, policy: MemoryPolicy, suffix = ''): string =>
		`${workload}-${skew}-${policy.label}${suffix}`.replace(/%/g, 'pct');
	const cells: CellPlan[] = [];
	for (const policy of policies) {
		for (const workload of pair.workloads) {
			for (const skew of pair.skews) cells.push({ id: cellId(workload, skew, policy), workload, skew, policy });
		}
	}
	for (const repeat of pair.repeats) {
		const policy = fabricPolicy(`${Math.round(repeat.step * 100)}%`, repeat.step, startLimitBytes);
		cells.push({
			id: cellId(repeat.workload, repeat.skew, policy, '-repeat'),
			workload: repeat.workload,
			skew: repeat.skew,
			policy,
		});
	}
	const unconstrained = unconstrainedPolicy(startLimitBytes);
	return {
		...pair,
		records,
		keyWidth: String(records - 1).length,
		startLimitBytes,
		rateFraction: profile.rateFraction,
		timing: profile.timing,
		calibrations: pair.workloads.flatMap((workload) =>
			pair.skews.map((skew) => ({ workload, skew, policy: unconstrained }))
		),
		cells,
	};
}

export function planProfile(profileName: string, pairNames?: string[]): PairPlan[] {
	const profile = PROFILES[profileName];
	if (!profile) throw new Error(`unknown profile ${profileName}; known: ${Object.keys(PROFILES).join(', ')}`);
	const pairs = pairNames ? profile.pairs.filter((pair) => pairNames.includes(pair.name)) : profile.pairs;
	if (pairNames && pairs.length !== pairNames.length) {
		throw new Error(
			`unknown pair in ${pairNames.join(', ')}; ${profileName} has ${profile.pairs.map((p) => p.name).join(', ')}`
		);
	}
	return pairs.map((pair) => planPair(pair, profile));
}

/** Rough wall-clock hours for a pair: load, calibration and cells, with a per-restart allowance. */
export function estimatedHours(plan: PairPlan, loadRecordsPerSec = 8000): number {
	const restart = 60;
	const { warmupSec, measureSec, calibrateWarmupSec, calibrateMeasureSec } = plan.timing;
	const seconds =
		plan.records / loadRecordsPerSec +
		1800 +
		plan.calibrations.length * (calibrateWarmupSec + calibrateMeasureSec + restart) +
		plan.cells.length * (warmupSec + measureSec + restart);
	return seconds / 3600;
}
