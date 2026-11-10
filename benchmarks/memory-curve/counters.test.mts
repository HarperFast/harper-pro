import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { blockCacheCounters, blockCacheWindow, parseServerSnapshot, windowMetrics } from './counters.mts';

interface DumpOptions {
	time: number;
	reads: number;
	readSectors: number;
	readMs: number;
	rios?: number;
	pgmajfault?: number;
	usageUsec?: number;
	memorySome?: number;
	ioSome?: number;
	oomKill?: number;
	startedAt?: string;
	pid?: number;
	memoryHigh?: string;
}

function dump(o: DumpOptions): string {
	return `@@ time
${o.time}
@@ devnum
8:16
@@ diskstats
   8      16 sdb ${o.reads} 12 ${o.readSectors} ${o.readMs} 500 3 8000 900 0 4000 5000 0 0 0 0 0 0
@@ io.stat
8:0 rbytes=999 wbytes=999 rios=9 wios=9 dbytes=0 dios=0
8:16 rbytes=${(o.rios ?? 0) * 4096} wbytes=4096000 rios=${o.rios ?? 0} wios=1000 dbytes=0 dios=0
@@ memory.stat
anon 1000000
file 2000000
pgmajfault ${o.pgmajfault ?? 0}
@@ memory.events
low 0
high 4
max 1
oom 0
oom_kill ${o.oomKill ?? 0}
oom_group_kill 0
@@ cpu.stat
usage_usec ${o.usageUsec ?? 0}
user_usec 0
system_usec 0
@@ memory.pressure
some avg10=0.00 avg60=0.00 avg300=0.00 total=${o.memorySome ?? 0}
full avg10=0.00 avg60=0.00 avg300=0.00 total=0
@@ io.pressure
some avg10=0.00 avg60=0.00 avg300=0.00 total=${o.ioSome ?? 0}
full avg10=0.00 avg60=0.00 avg300=0.00 total=0
@@ cpu.pressure
some avg10=0.00 avg60=0.00 avg300=0.00 total=0
full avg10=0.00 avg60=0.00 avg300=0.00 total=0
@@ memory.current
3000000
@@ memory.max
6442450944
@@ memory.high
${o.memoryHigh ?? 'max'}
@@ container
${o.startedAt ?? '2026-11-10T05:00:00.1Z'} 0 false ${o.pid ?? 1234}
`;
}

describe('parseServerSnapshot', () => {
	it('reads every section', () => {
		const snapshot = parseServerSnapshot(
			dump({ time: 100.5, reads: 10, readSectors: 80, readMs: 20, rios: 7, memoryHigh: '5368709120' })
		);
		assert.equal(snapshot.timeSeconds, 100.5);
		assert.equal(snapshot.device, 'sdb');
		assert.deepEqual(snapshot.disk, {
			reads: 10,
			readSectors: 80,
			readMs: 20,
			writes: 500,
			writeSectors: 8000,
			writeMs: 900,
			ioMs: 4000,
		});
		assert.deepEqual(snapshot.cgroupIo, { rbytes: 7 * 4096, rios: 7, wbytes: 4096000, wios: 1000 });
		assert.equal(snapshot.memoryStat.file, 2000000);
		assert.equal(snapshot.memoryEvents.oom_kill, 0);
		assert.equal(snapshot.memoryMax, 6442450944);
		assert.equal(snapshot.memoryHigh, 5368709120);
		assert.deepEqual(snapshot.container, {
			startedAt: '2026-11-10T05:00:00.1Z',
			restartCount: 0,
			oomKilled: false,
			pid: 1234,
		});
	});

	it('reads "max" limits as unlimited', () => {
		assert.equal(parseServerSnapshot(dump({ time: 1, reads: 0, readSectors: 0, readMs: 0 })).memoryHigh, null);
	});

	it('fails on a missing section', () => {
		assert.throws(
			() => parseServerSnapshot(dump({ time: 1, reads: 0, readSectors: 0, readMs: 0 }).replace(/@@ cpu.stat[^@]*/, '')),
			/cpu.stat/
		);
	});
});

describe('windowMetrics', () => {
	it('computes per-second rates and mean read latency', () => {
		const before = parseServerSnapshot(
			dump({
				time: 1000,
				reads: 100,
				readSectors: 800,
				readMs: 50,
				rios: 100,
				pgmajfault: 10,
				usageUsec: 0,
				memorySome: 0,
				ioSome: 0,
			})
		);
		const after = parseServerSnapshot(
			dump({
				time: 1010,
				reads: 1100,
				readSectors: 8800,
				readMs: 1050,
				rios: 1050,
				pgmajfault: 60,
				usageUsec: 20_000_000,
				memorySome: 500_000,
				ioSome: 2_000_000,
			})
		);
		const metrics = windowMetrics(before, after);
		assert.equal(metrics.seconds, 10);
		assert.equal(metrics.disk.readsPerSec, 100);
		assert.equal(metrics.disk.readBytesPerSec, (8000 * 512) / 10);
		assert.equal(metrics.disk.meanReadLatencyMs, 1);
		assert.equal(metrics.cgroupIo!.readsPerSec, 95);
		assert.equal(metrics.majorFaultsPerSec, 5);
		assert.equal(metrics.cpuCores, 2);
		assert.equal(metrics.psi.memorySomePct, 5);
		assert.equal(metrics.psi.ioSomePct, 20);
		assert.deepEqual(metrics.invalidReasons, []);
	});

	it('reports read latency as unavailable when there were no reads', () => {
		const before = parseServerSnapshot(dump({ time: 0, reads: 5, readSectors: 40, readMs: 3 }));
		const after = parseServerSnapshot(dump({ time: 60, reads: 5, readSectors: 40, readMs: 3 }));
		const metrics = windowMetrics(before, after);
		assert.equal(metrics.disk.readsPerSec, 0);
		assert.equal(metrics.disk.meanReadLatencyMs, null);
	});

	it('invalidates the window on an OOM kill, a restart, or a counter reset', () => {
		const before = parseServerSnapshot(dump({ time: 0, reads: 500, readSectors: 40, readMs: 3 }));
		const oom = windowMetrics(
			before,
			parseServerSnapshot(dump({ time: 60, reads: 600, readSectors: 50, readMs: 4, oomKill: 1 }))
		);
		assert.ok(oom.invalidReasons.some((r) => r.includes('OOM')));
		const restarted = windowMetrics(
			before,
			parseServerSnapshot(
				dump({ time: 60, reads: 600, readSectors: 50, readMs: 4, startedAt: '2026-11-10T05:09:00Z', pid: 99 })
			)
		);
		assert.ok(restarted.invalidReasons.some((r) => r.includes('restarted')));
		const reset = windowMetrics(before, parseServerSnapshot(dump({ time: 60, reads: 10, readSectors: 50, readMs: 4 })));
		assert.ok(reset.invalidReasons.some((r) => r.includes('disk.reads')));
	});

	it('rejects a non-positive window', () => {
		const snapshot = parseServerSnapshot(dump({ time: 5, reads: 0, readSectors: 0, readMs: 0 }));
		assert.throws(() => windowMetrics(snapshot, snapshot), /non-positive/);
	});
});

describe('block cache', () => {
	const info = (hit: number, miss: number, dataHit: number, dataMiss: number) => ({
		metrics: {
			data: {
				blockCacheHit: hit,
				blockCacheMiss: miss,
				blockCacheDataHit: dataHit,
				blockCacheDataMiss: dataMiss,
				blockCacheUsage: 900,
				blockCacheCapacity: 1000,
				tables: {},
			},
		},
	});

	it('computes hit rates over the window', () => {
		const window = blockCacheWindow(
			blockCacheCounters(info(100, 100, 50, 50), 'data'),
			blockCacheCounters(info(1000, 200, 850, 150), 'data'),
			10
		);
		assert.equal(window.hitRate, 900 / 1000);
		assert.equal(window.dataHitRate, 800 / 900);
		assert.equal(window.dataMissesPerSec, 10);
		assert.equal(window.capacityBytes, 1000);
	});

	it('reports no hit rate without lookups, and fails without counters', () => {
		const counters = blockCacheCounters(info(1, 1, 1, 1), 'data');
		assert.equal(blockCacheWindow(counters, counters, 10).hitRate, null);
		assert.throws(() => blockCacheCounters({ metrics: {} }, 'data'), /no RocksDB block-cache counters/);
	});
});
