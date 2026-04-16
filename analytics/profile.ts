/**
 * This module is responsible for profiling threads so we can determine how much CPU usage can be attributed
 * to user code, harper code, and individual "hot" functions
 */
import { recordAction } from '../core/resources/analytics/write.ts';
import { getHdbBasePath } from '../core/utility/environment/environmentManager.js';
import { PACKAGE_ROOT } from '../core/utility/packageUtils.js';
import { realpathSync, readFileSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
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
const SAMPLING_INTERVAL_IN_MICROSECONDS = 50000;
// Running this on the thread itself can be a problematic because the profiler snapshots are somewhat expensive
//  (calling timeProfiler.stop and getting the large block of JSON and parsing it). This can take a 5ms or more
//  which can have some impact on latency for users. However, the datadog profiler is much better than the node
//  profiler, so we'll keep this for now.
export function handleApplication({ options }: Scope) {
	setTimeout(async () => {
		if (userCodeFolders.length === 0) return;
		// start the profiler
		if (!profilerStarted) {
			profilerStarted = true;
			timeProfiler.start({ intervalMicros: SAMPLING_INTERVAL_IN_MICROSECONDS });
		}
		capturePeriod = ((options.get(['aggregatePeriod']) as number) ?? 60) * 1000;
		if (capturePeriod > 0) {
			profilerTimer = setTimeout(() => {
				captureProfile(capturePeriod);
			}, capturePeriod).unref();
		}
	}, 1000); // wait for everything to load before we start the profiler
}
let lastChildCpuTime = 0;

export async function captureProfile(delayToNextCapture = (capturePeriod ?? 60) * 1000): Promise<void> {
	clearTimeout(profilerTimer);
	if (!profilerStarted) {
		profilerStarted = true;
		timeProfiler.start({ intervalMicros: SAMPLING_INTERVAL_IN_MICROSECONDS });
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
	const gpuPromise = getWorkerIndex() === 0 ? getGpuUtilization() : null;
	try {
		const profile = timeProfiler.stop(true);
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
		// and start the profiler again
		if (delayToNextCapture > 0) {
			profilerTimer = setTimeout(() => {
				captureProfile();
			}, delayToNextCapture).unref();
		} else {
			// somehow this can later get set to a negative number which causes big problems (high-frequency restarts of the profiler)
			log.info?.('Profiling disabled');
			timeProfiler.stop();
		}
	}
	// this traverses the nodes and returns the number of sampling hits for the sample and attributes it
	// to harper or user code (as opposed to execution of things like node internal modules or native code)
	function getUserHitCount(sample: Sample) {
		// if we can assign to user code or harper code, do so
		let recordedTopSample = false;
		for (let locationId of sample.locationId) {
			let fileName = fileNameById.get(locationById.get(locationId).functionId);
			if (userCodeFolders.some((userCodeFolder) => fileName.startsWith(userCodeFolder))) {
				// the call frame location is in user code
				const sampleCount = sample.value[0];
				totalUserCount += sampleCount;
				if (!recordedTopSample)
					samplesByLocationId.set(locationId, (samplesByLocationId.get(locationId) ?? 0) + sampleCount);
				return; // if the highest point in the call stack is in user code, we don't need to check the rest of the call stack, this "counts" as user execution
			}
			if (fileName.startsWith(PACKAGE_ROOT)) {
				const sampleCount = sample.value[0];
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

		const { stdout } = await execFileAsync('nvidia-smi', ['pmon', '-c', '1', '-s', 'u'], {
			timeout: 5000,
		});

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
