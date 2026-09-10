/**
 * This module is responsible for profiling threads so we can determine how much CPU usage can be attributed
 * to user code, harper code, and individual "hot" functions
 */
import { recordAction } from '../core/resources/analytics/write.ts';
import { getHdbBasePath } from '../core/utility/environment/environmentManager.js';
import { PACKAGE_ROOT } from '../core/utility/packageUtils.js';
import { existsSync, realpathSync, readFileSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { time as timeProfiler } from '@datadog/pprof';
import { getWorkerIndex } from '../core/server/threads/manageThreads.js';
import * as log from '../core/utility/logging/harper_logger.js';
import type { Scope } from '../core/components/Scope.ts';

type Profile = ReturnType<typeof timeProfiler.stop>;
type Sample = Profile['sample'][0];
const basePath = getHdbBasePath();
let capturePeriod = 1000;
export const userCodeFolders = basePath ? [basePath] : [];
if (process.env.RUN_HDB_APP) userCodeFolders.push(realpathSync(process.env.RUN_HDB_APP));

let profilerTimer: NodeJS.Timeout | undefined;
let profilerStarted = false;
// @datadog/pprof prebuilds link the raw V8 ABI and segfault under V8 pointer compression. The
// pointer-compression Docker image swaps in a binary rebuilt for that ABI and marks the package
// with .pointer-compression-build; without the marker, skip profiling instead of crashing.
const profilerSupported = (() => {
	if ((process.config?.variables as { v8_enable_pointer_compression?: number })?.v8_enable_pointer_compression !== 1)
		return true;
	try {
		const pprofDir = dirname(createRequire(__filename).resolve('@datadog/pprof/package.json'));
		return existsSync(join(pprofDir, '.pointer-compression-build'));
	} catch {
		return false;
	}
})();
function profilerUnavailable(): boolean {
	if (profilerSupported) return false;
	log.warn?.(
		'Profiling disabled: @datadog/pprof is not built for this pointer-compression Node runtime (its prebuilds target the standard V8 ABI and would crash)'
	);
	return true;
}
const SAMPLING_INTERVAL_IN_MICROSECONDS = 50000;
// Running this on the thread itself can be a problematic because the profiler snapshots are somewhat expensive
//  (calling timeProfiler.stop and getting the large block of JSON and parsing it). This can take a 5ms or more
//  which can have some impact on latency for users. However, the datadog profiler is much better than the node
//  profiler, so we'll keep this for now.
export function handleApplication({ options }: Scope) {
	setTimeout(() => startAutomaticProfiling(options), 1000); // wait for everything to load before we start the profiler
}

// Sampling nobody captures still costs a SIGPROF stack walk every 50ms on every worker.
export function startAutomaticProfiling(options: Scope['options']): boolean {
	if (userCodeFolders.length === 0) return false;
	const aggregatePeriod = Number(options.get(['aggregatePeriod']) ?? 60);
	capturePeriod = Number.isFinite(aggregatePeriod) ? aggregatePeriod * 1000 : 0;
	const disabledReason =
		options.get(['profiling']) === false
			? 'Profiling disabled by configuration'
			: !(capturePeriod > 0)
				? 'Profiling not started: analytics.aggregatePeriod is not positive, so nothing would capture it'
				: undefined;
	if (disabledReason) {
		log.info?.(disabledReason);
		if (profilerStarted) captureProfile(-1);
		return false;
	}
	if (profilerUnavailable()) return false;
	if (!profilerStarted && !startProfiler()) return false;
	scheduleCapture(capturePeriod, capturePeriod);
	return true;
}

// A capture's successor runs after the delay that capture was asked for, and is itself asked for
// `delayAfterThat`. Automatic profiling asks the first capture for one period and every later one
// for the shipped default, so captures land at one and two periods and then a thousand periods out.
function scheduleCapture(delay: number, delayAfterThat = shippedRescheduleDelay()) {
	clearTimeout(profilerTimer);
	captureGeneration++;
	profilerTimer = setTimeout(() => {
		captureProfile(delayAfterThat);
	}, delay).unref();
}

// Entry and completion markers place a wedge inside the native call (harper-pro#788); the entry
// line can still sit in the file logger's write buffer if the thread never runs again.
function startProfiler(): boolean {
	const startedAt = performance.now();
	log.debug?.('Profiler start requested');
	try {
		timeProfiler.start({ intervalMicros: SAMPLING_INTERVAL_IN_MICROSECONDS });
	} catch (error) {
		log.error?.('Profiler failed to start:', error);
		return false;
	} finally {
		profilerStarted = timeProfiler.isStarted();
	}
	log.debug?.(`Profiler started in ${(performance.now() - startedAt).toFixed(1)}ms`);
	return true;
}

function stopProfiler(restart: boolean): Profile {
	const startedAt = performance.now();
	log.debug?.(`Profiler stop requested (restart=${restart})`);
	try {
		return timeProfiler.stop(restart);
	} finally {
		profilerStarted = timeProfiler.isStarted();
		log.debug?.(`Profiler stop returned after ${(performance.now() - startedAt).toFixed(1)}ms (restart=${restart})`);
	}
}
let lastChildCpuTime = 0;
let gpuAvailable = true;
// Bumped by every capture and lifecycle change, so a capture still awaiting GPU measurement when a
// later one stopped the profiler cannot re-arm it from its own finally.
let captureGeneration = 0;

// The cadence that ships: capturePeriod is already milliseconds, so an omitted delay reschedules a
// thousand periods out and production captures twice after start and then roughly never. Kept on
// purpose — a capture every period (a synchronous V8 profiler stop/start on every thread) at a short
// period loses db-write analytics in integrationTests/cluster/replicatedAnalyticsUnion.test.mjs;
// restoring per-period captures needs that interaction understood first.
// Capped at Node's largest timeout: past 2^31-1 ms a timer fires after 1 ms, which for
// aggregatePeriod >= 2148 s meant a profiler stop/start every millisecond on every thread.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
function shippedRescheduleDelay(): number {
	return Math.min((capturePeriod ?? 60) * 1000, MAX_TIMEOUT_MS);
}

export async function captureProfile(delayToNextCapture = shippedRescheduleDelay()): Promise<void> {
	clearTimeout(profilerTimer);
	if (profilerUnavailable()) return;
	const continuous = delayToNextCapture > 0;
	const generation = ++captureGeneration;
	if (!profilerStarted) {
		if (continuous && startProfiler()) scheduleCapture(delayToNextCapture);
		return;
	}
	const hitCountThreshold = 100;
	const secondsPerHit = SAMPLING_INTERVAL_IN_MICROSECONDS / 1_000_000;
	const CHILD_TIME_THRESHOLD = 0.001;
	const locationById = new Map<number, any>();
	const fileNameById = new Map<number, any>();
	const samplesByLocationId = new Map<number, number>();
	let totalUserCount = 0;
	let totalHarperCount = 0;
	// Start GPU measurement early so it runs in parallel with CPU profiling work
	const gpuPromise = getWorkerIndex() === 0 && gpuAvailable ? getGpuUtilization() : null;
	try {
		const profile = stopProfiler(continuous);
		const strings = profile.stringTable.strings;
		for (let func of profile.function) {
			fileNameById.set(func.id as number, strings[func.filename as number]);
		}
		for (let location of profile.location) {
			locationById.set(location.id as number, location.line[0]);
		}

		for (const sample of profile.sample) {
			getUserHitCount(sample);
		}
		recordAction(totalHarperCount * secondsPerHit, 'cpu-usage', 'harper');
		recordAction(totalUserCount * secondsPerHit, 'cpu-usage', 'user');
		for (let [locationId, sampleCount] of samplesByLocationId) {
			if (sampleCount > hitCountThreshold) {
				const location = locationById.get(locationId);
				const locationName = fileNameById.get(location.functionId) + ':' + location.line;
				recordAction(sampleCount * secondsPerHit, 'cpu-usage', locationName);
			}
		}
		if (getWorkerIndex() === 0) {
			// Record child process CPU time
			const childCpuTime = getChildProcessCpuTime();
			if (childCpuTime !== null) {
				const childCpuTimeInInterval = childCpuTime - lastChildCpuTime;
				if (childCpuTimeInInterval > CHILD_TIME_THRESHOLD)
					recordAction(childCpuTimeInInterval, 'cpu-usage', 'user', 'child-processes');
				lastChildCpuTime = childCpuTime;
			}
			// Record GPU utilization for this process and child processes
			const gpuSeconds = await gpuPromise;
			if (gpuSeconds !== null) {
				recordAction(gpuSeconds, 'gpu-usage', 'user');
			}
		}
	} catch (error) {
		log.error?.('analytics profiler error:', error);
	} finally {
		if (!continuous) log.info?.('Profiling disabled');
		else if (generation === captureGeneration) scheduleCapture(delayToNextCapture);
	}
	// this traverses the nodes and returns the number of sampling hits for the sample and attributes it
	// to harper or user code (as opposed to execution of things like node internal modules or native code)
	function getUserHitCount(sample: Sample) {
		// if we can assign to user code or harper code, do so
		let recordedTopSample = false;
		for (let locationId of sample.locationId as number[]) {
			let fileName = fileNameById.get(locationById.get(locationId).functionId);
			if (userCodeFolders.some((userCodeFolder) => fileName.startsWith(userCodeFolder))) {
				// the call frame location is in user code
				const sampleCount = sample.value[0] as number;
				totalUserCount += sampleCount;
				if (!recordedTopSample)
					samplesByLocationId.set(locationId, (samplesByLocationId.get(locationId) ?? 0) + sampleCount);
				return; // if the highest point in the call stack is in user code, we don't need to check the rest of the call stack, this "counts" as user execution
			}
			if (fileName.startsWith(PACKAGE_ROOT)) {
				const sampleCount = sample.value[0] as number;
				totalHarperCount += sampleCount;
				if (!recordedTopSample) {
					samplesByLocationId.set(locationId, (samplesByLocationId.get(locationId) ?? 0) + sampleCount);
					recordedTopSample = true;
				}
			}
		}
	}
}

/**
 * Get the total CPU time (in seconds) consumed by all child/descendant processes.
 * Recursively finds all descendants by traversing /proc and summing their CPU time.
 * Also includes cutime/cstime from the current process for terminated children.
 * Only works on Linux.
 */
function getChildProcessCpuTime(): number | null {
	try {
		const currentPid = process.pid;
		const descendants = findAllDescendants(currentPid);
		let totalCpuTime = 0;
		const clockTicksPerSecond = 100; // Usually 100 on Linux

		// Get CPU time from currently running descendants
		for (const pid of descendants) {
			try {
				const statContent = readFileSync(`/proc/${pid}/stat`, 'utf8');
				// Parse stat file: pid (comm) state ppid ... utime stime ...
				// Split by ') ' to handle process names with spaces/special chars
				const statParts = statContent.split(') ')[1].split(' ');
				const utime = parseInt(statParts[11], 10); // user time (index 13 - 2)
				const stime = parseInt(statParts[12], 10); // system time (index 14 - 2)
				totalCpuTime += (utime + stime) / clockTicksPerSecond;
			} catch {
				// Process may have terminated, skip it
			}
		}

		// Add CPU time from terminated children (cutime + cstime from current process)
		try {
			const statContent = readFileSync(`/proc/${currentPid}/stat`, 'utf8');
			const statParts = statContent.split(') ')[1].split(' ');
			const cutime = parseInt(statParts[13], 10); // child user time (index 15 - 2)
			const cstime = parseInt(statParts[14], 10); // child system time (index 16 - 2)
			totalCpuTime += (cutime + cstime) / clockTicksPerSecond;
		} catch {
			// Ignore if we can't read our own stats
		}

		return totalCpuTime;
	} catch {
		// Silently return null if /proc is not available (non-Linux) or read fails
		return null;
	}
}

/**
 * Get the total SM (shader/streaming multiprocessor) utilization percentage across all GPUs
 * for this process and all descendant processes.
 * Uses nvidia-smi pmon for per-process GPU utilization.
 * Only works on Linux with NVIDIA GPUs. Returns null if unavailable.
 */
async function getGpuUtilization(): Promise<number | null> {
	try {
		const currentPid = process.pid;
		const descendants = findAllDescendants(currentPid);
		const pidsToMonitor = new Set([currentPid, ...descendants]);

		const { stdout } = await execFileAsync('nvidia-smi', ['pmon', '-c', '1', '-s', 'u']);

		let totalSmPercent = 0;
		for (const line of stdout.split('\n')) {
			if (line.startsWith('#') || !line.trim()) continue;
			const parts = line.trim().split(/\s+/);
			// pmon -s u format: gpu pid type fb sm enc dec jpg ofa command
			if (parts.length < 5) continue;
			const pid = parseInt(parts[1], 10);
			if (isNaN(pid) || !pidsToMonitor.has(pid)) continue;
			const sm = parseInt(parts[4], 10); // SM utilization %
			if (!isNaN(sm)) totalSmPercent += sm;
		}

		// Convert SM utilization % to GPU-seconds over the capture period
		// e.g. 50% utilization over 60s = 30 GPU-seconds
		return (totalSmPercent / 100) * (capturePeriod / 1000);
	} catch {
		gpuAvailable = false;
		return null;
	}
}

/**
 * Recursively find all descendant PIDs of the given parent PID.
 */
function findAllDescendants(parentPid: number): Set<number> {
	const descendants = new Set<number>();

	try {
		// Get all entries in /proc
		const procEntries = readdirSync('/proc');

		// Build a map of pid -> parent pid
		const pidToParent = new Map<number, number>();
		for (const entry of procEntries) {
			const pid = parseInt(entry, 10);
			if (isNaN(pid)) continue;

			try {
				const statContent = readFileSync(`/proc/${pid}/stat`, 'utf8');
				// Extract ppid (parent pid) - it's at index 3 after splitting by ') '
				const statParts = statContent.split(') ')[1].split(' ');
				const ppid = parseInt(statParts[1], 10); // ppid is at index 3 - 2
				pidToParent.set(pid, ppid);
			} catch {
				// Process may have terminated, skip it
			}
		}

		// Recursively find all descendants
		const toProcess = [parentPid];
		const processed = new Set<number>();

		while (toProcess.length > 0) {
			const currentPid = toProcess.pop()!;
			if (processed.has(currentPid)) continue;
			processed.add(currentPid);

			// Find direct children of currentPid
			for (const [pid, ppid] of pidToParent.entries()) {
				if (ppid === currentPid && !processed.has(pid)) {
					descendants.add(pid);
					toProcess.push(pid);
				}
			}
		}
	} catch {
		// /proc not available or other error
	}

	return descendants;
}
