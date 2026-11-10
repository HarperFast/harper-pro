/**
 * Parses the raw counter dump `server-ctl.sh counters` prints on the server VM, and turns two
 * snapshots into per-window rates. Kernel semantics: https://docs.kernel.org/admin-guide/iostats.html
 * (diskstats), https://docs.kernel.org/admin-guide/cgroup-v2.html (io.stat, memory.*, cpu.stat, PSI).
 * Device read latency is the mean over the window of time reads spent in the block layer and device,
 * queueing included; with no reads it is unavailable (null), not zero.
 */

export interface DiskCounters {
	reads: number;
	readSectors: number;
	readMs: number;
	writes: number;
	writeSectors: number;
	writeMs: number;
	ioMs: number;
}

export interface PressureCounters {
	someTotalMicros: number;
	fullTotalMicros: number | null;
}

export interface ContainerIdentity {
	startedAt: string;
	restartCount: number;
	oomKilled: boolean;
	pid: number;
}

export interface ServerSnapshot {
	timeSeconds: number;
	device: string;
	disk: DiskCounters;
	cgroupIo: { rbytes: number; rios: number; wbytes: number; wios: number } | null;
	/** The container's reads on every device, including image and code pages read back from the boot disk. */
	cgroupIoAllDevices: { rbytes: number; rios: number };
	memoryStat: Record<string, number>;
	memoryEvents: Record<string, number>;
	cpuStat: Record<string, number>;
	pressure: { memory: PressureCounters; io: PressureCounters; cpu: PressureCounters };
	memoryCurrent: number;
	memoryMax: number | null;
	memoryHigh: number | null;
	container: ContainerIdentity;
}

function sections(raw: string): Map<string, string[]> {
	const result = new Map<string, string[]>();
	let current: string[] | undefined;
	for (const line of raw.split('\n')) {
		const header = /^@@ (\S+)$/.exec(line);
		if (header) {
			current = [];
			result.set(header[1], current);
		} else if (current && line.trim() !== '') {
			current.push(line.trim());
		}
	}
	return result;
}

function required(map: Map<string, string[]>, name: string): string[] {
	const lines = map.get(name);
	if (!lines || lines.length === 0) throw new Error(`counter dump is missing section ${name}`);
	return lines;
}

function keyValueLines(lines: string[]): Record<string, number> {
	const result: Record<string, number> = {};
	for (const line of lines) {
		const [key, value] = line.split(/\s+/);
		const number = Number(value);
		if (key && Number.isFinite(number)) result[key] = number;
	}
	return result;
}

function limitValue(text: string): number | null {
	return text === 'max' ? null : Number(text);
}

export function parseDiskstatsLine(line: string): { device: string; counters: DiskCounters } {
	const fields = line.split(/\s+/);
	if (fields.length < 14) throw new Error(`malformed diskstats line: ${line}`);
	const n = (i: number): number => Number(fields[i]);
	return {
		device: fields[2],
		counters: {
			reads: n(3),
			readSectors: n(5),
			readMs: n(6),
			writes: n(7),
			writeSectors: n(9),
			writeMs: n(10),
			ioMs: n(12),
		},
	};
}

function ioStatLine(line: string): { device: string; values: Record<string, number> } {
	const [device, ...pairs] = line.split(/\s+/);
	const values: Record<string, number> = {};
	for (const pair of pairs) {
		const [name, value] = pair.split('=');
		values[name] = Number(value);
	}
	return { device, values };
}

export function parseIoStat(lines: string[], devnum: string): ServerSnapshot['cgroupIo'] {
	for (const line of lines) {
		const { device, values } = ioStatLine(line);
		if (device !== devnum) continue;
		return { rbytes: values.rbytes ?? 0, rios: values.rios ?? 0, wbytes: values.wbytes ?? 0, wios: values.wios ?? 0 };
	}
	return null;
}

export function sumIoStatReads(lines: string[]): ServerSnapshot['cgroupIoAllDevices'] {
	const total = { rbytes: 0, rios: 0 };
	for (const line of lines) {
		if (!line.trim()) continue;
		const { values } = ioStatLine(line);
		total.rbytes += values.rbytes ?? 0;
		total.rios += values.rios ?? 0;
	}
	return total;
}

export function parsePressure(lines: string[]): PressureCounters {
	let some: number | undefined;
	let full: number | null = null;
	for (const line of lines) {
		const total = /total=(\d+)/.exec(line);
		if (!total) continue;
		if (line.startsWith('some')) some = Number(total[1]);
		else if (line.startsWith('full')) full = Number(total[1]);
	}
	if (some === undefined) throw new Error(`malformed pressure file: ${lines.join(' | ')}`);
	return { someTotalMicros: some, fullTotalMicros: full };
}

export function parseServerSnapshot(raw: string): ServerSnapshot {
	const map = sections(raw);
	const devnum = required(map, 'devnum')[0];
	const { device, counters } = parseDiskstatsLine(required(map, 'diskstats')[0]);
	const [startedAt, restartCount, oomKilled, pid] = required(map, 'container')[0].split(/\s+/);
	return {
		timeSeconds: Number(required(map, 'time')[0]),
		device,
		disk: counters,
		cgroupIo: parseIoStat(map.get('io.stat') ?? [], devnum),
		cgroupIoAllDevices: sumIoStatReads(map.get('io.stat') ?? []),
		memoryStat: keyValueLines(required(map, 'memory.stat')),
		memoryEvents: keyValueLines(required(map, 'memory.events')),
		cpuStat: keyValueLines(required(map, 'cpu.stat')),
		pressure: {
			memory: parsePressure(required(map, 'memory.pressure')),
			io: parsePressure(required(map, 'io.pressure')),
			cpu: parsePressure(required(map, 'cpu.pressure')),
		},
		memoryCurrent: Number(required(map, 'memory.current')[0]),
		memoryMax: limitValue(required(map, 'memory.max')[0]),
		memoryHigh: limitValue(required(map, 'memory.high')[0]),
		container: { startedAt, restartCount: Number(restartCount), oomKilled: oomKilled === 'true', pid: Number(pid) },
	};
}

export interface WindowMetrics {
	seconds: number;
	disk: {
		readsPerSec: number;
		readBytesPerSec: number;
		meanReadLatencyMs: number | null;
		writesPerSec: number;
		writeBytesPerSec: number;
		utilization: number;
	};
	cgroupIo: { readsPerSec: number; readBytesPerSec: number; writesPerSec: number; writeBytesPerSec: number } | null;
	cgroupIoAllDevices: { readsPerSec: number; readBytesPerSec: number };
	majorFaultsPerSec: number;
	cpuCores: number;
	psi: {
		memorySomePct: number;
		memoryFullPct: number | null;
		ioSomePct: number;
		ioFullPct: number | null;
		cpuSomePct: number;
	};
	memoryEvents: { high: number; max: number; oomKill: number };
	memoryEnd: {
		currentBytes: number;
		fileBytes: number;
		anonBytes: number;
		maxBytes: number | null;
		highBytes: number | null;
	};
	invalidReasons: string[];
}

function pressurePct(before: PressureCounters, after: PressureCounters, seconds: number): number {
	return ((after.someTotalMicros - before.someTotalMicros) / 1e6 / seconds) * 100;
}

function fullPressurePct(before: PressureCounters, after: PressureCounters, seconds: number): number | null {
	if (before.fullTotalMicros === null || after.fullTotalMicros === null) return null;
	return ((after.fullTotalMicros - before.fullTotalMicros) / 1e6 / seconds) * 100;
}

export function windowMetrics(before: ServerSnapshot, after: ServerSnapshot): WindowMetrics {
	const seconds = after.timeSeconds - before.timeSeconds;
	if (!(seconds > 0)) throw new Error(`window has non-positive length ${seconds}s`);
	const invalidReasons: string[] = [];
	if (
		after.container.startedAt !== before.container.startedAt ||
		after.container.restartCount !== before.container.restartCount ||
		after.container.pid !== before.container.pid
	) {
		invalidReasons.push('container restarted during the window');
	}
	if (after.device !== before.device)
		invalidReasons.push(`data device changed from ${before.device} to ${after.device}`);
	const delta = (a: number, b: number, name: string): number => {
		const value = b - a;
		if (value < 0) invalidReasons.push(`counter ${name} went backwards`);
		return value;
	};
	const reads = delta(before.disk.reads, after.disk.reads, 'disk.reads');
	const readMs = delta(before.disk.readMs, after.disk.readMs, 'disk.readMs');
	const oomKill = delta(before.memoryEvents.oom_kill ?? 0, after.memoryEvents.oom_kill ?? 0, 'memory.events.oom_kill');
	if (oomKill > 0) invalidReasons.push(`${oomKill} OOM kill(s) during the window`);
	if (after.container.oomKilled) invalidReasons.push('container reports OOMKilled');
	let cgroupIo: WindowMetrics['cgroupIo'] = null;
	if (before.cgroupIo && after.cgroupIo) {
		cgroupIo = {
			readsPerSec: delta(before.cgroupIo.rios, after.cgroupIo.rios, 'io.stat.rios') / seconds,
			readBytesPerSec: delta(before.cgroupIo.rbytes, after.cgroupIo.rbytes, 'io.stat.rbytes') / seconds,
			writesPerSec: delta(before.cgroupIo.wios, after.cgroupIo.wios, 'io.stat.wios') / seconds,
			writeBytesPerSec: delta(before.cgroupIo.wbytes, after.cgroupIo.wbytes, 'io.stat.wbytes') / seconds,
		};
	}
	return {
		seconds,
		disk: {
			readsPerSec: reads / seconds,
			readBytesPerSec: (delta(before.disk.readSectors, after.disk.readSectors, 'disk.readSectors') * 512) / seconds,
			meanReadLatencyMs: reads > 0 ? readMs / reads : null,
			writesPerSec: delta(before.disk.writes, after.disk.writes, 'disk.writes') / seconds,
			writeBytesPerSec: (delta(before.disk.writeSectors, after.disk.writeSectors, 'disk.writeSectors') * 512) / seconds,
			utilization: delta(before.disk.ioMs, after.disk.ioMs, 'disk.ioMs') / 1000 / seconds,
		},
		cgroupIo,
		cgroupIoAllDevices: {
			readsPerSec:
				delta(before.cgroupIoAllDevices.rios, after.cgroupIoAllDevices.rios, 'io.stat all devices rios') / seconds,
			readBytesPerSec:
				delta(before.cgroupIoAllDevices.rbytes, after.cgroupIoAllDevices.rbytes, 'io.stat all devices rbytes') /
				seconds,
		},
		majorFaultsPerSec:
			delta(before.memoryStat.pgmajfault ?? 0, after.memoryStat.pgmajfault ?? 0, 'memory.stat.pgmajfault') / seconds,
		cpuCores:
			delta(before.cpuStat.usage_usec ?? 0, after.cpuStat.usage_usec ?? 0, 'cpu.stat.usage_usec') / 1e6 / seconds,
		psi: {
			memorySomePct: pressurePct(before.pressure.memory, after.pressure.memory, seconds),
			memoryFullPct: fullPressurePct(before.pressure.memory, after.pressure.memory, seconds),
			ioSomePct: pressurePct(before.pressure.io, after.pressure.io, seconds),
			ioFullPct: fullPressurePct(before.pressure.io, after.pressure.io, seconds),
			cpuSomePct: pressurePct(before.pressure.cpu, after.pressure.cpu, seconds),
		},
		memoryEvents: {
			high: delta(before.memoryEvents.high ?? 0, after.memoryEvents.high ?? 0, 'memory.events.high'),
			max: delta(before.memoryEvents.max ?? 0, after.memoryEvents.max ?? 0, 'memory.events.max'),
			oomKill,
		},
		memoryEnd: {
			currentBytes: after.memoryCurrent,
			fileBytes: after.memoryStat.file ?? 0,
			anonBytes: after.memoryStat.anon ?? 0,
			maxBytes: after.memoryMax,
			highBytes: after.memoryHigh,
		},
		invalidReasons,
	};
}

export interface BlockCacheCounters {
	hit: number;
	miss: number;
	dataHit: number;
	dataMiss: number;
	usage: number;
	capacity: number;
}

/** Block-cache counters for one database from a `system_information` `metrics` response. */
export function blockCacheCounters(systemInformation: any, database: string): BlockCacheCounters {
	const db = systemInformation?.metrics?.[database];
	if (!db || typeof db.blockCacheHit !== 'number') {
		throw new Error(`system_information has no RocksDB block-cache counters for database ${database}`);
	}
	return {
		hit: db.blockCacheHit,
		miss: db.blockCacheMiss,
		dataHit: db.blockCacheDataHit,
		dataMiss: db.blockCacheDataMiss,
		usage: db.blockCacheUsage,
		capacity: db.blockCacheCapacity,
	};
}

export interface BlockCacheWindow {
	hitRate: number | null;
	dataHitRate: number | null;
	dataMissesPerSec: number;
	usageBytes: number;
	capacityBytes: number;
}

export function blockCacheWindow(
	before: BlockCacheCounters,
	after: BlockCacheCounters,
	seconds: number
): BlockCacheWindow {
	const hit = after.hit - before.hit;
	const miss = after.miss - before.miss;
	const dataHit = after.dataHit - before.dataHit;
	const dataMiss = after.dataMiss - before.dataMiss;
	return {
		hitRate: hit + miss > 0 ? hit / (hit + miss) : null,
		dataHitRate: dataHit + dataMiss > 0 ? dataHit / (dataHit + dataMiss) : null,
		dataMissesPerSec: dataMiss / seconds,
		usageBytes: after.usage,
		capacityBytes: after.capacity,
	};
}
