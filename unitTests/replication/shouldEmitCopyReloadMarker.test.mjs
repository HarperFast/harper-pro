/**
 * A copyApply base copy writes rows as audit-less snapshots, invisible to the live-notify path. On copy
 * completion `emitCopyReloadMarkers` fires a per-table "reload" marker that re-drives live subscribers to
 * re-read their scope, recovering those rows (harper-pro#495). `shouldEmitCopyReloadMarker` is the gate
 * that decides which tables get a marker.
 *
 * The marker is only useful for a table that actually received an audit-less copy-apply row: emitting for
 * an empty / non-replicated / fully-audited user table is wasted work (cb1kenobi review, PR #507). The
 * system DB is the exception — its cluster-machinery reload tables are a fixed list that must always
 * re-drive their subscribers regardless of how many rows the copy carried.
 */

import { expect } from 'chai';
import {
	shouldEmitCopyReloadMarker,
	SYSTEM_RELOAD_TABLES,
	writeReloadMarkerWithRetry,
} from '#src/replication/replicationConnection';
import { WAF_RULE_TABLE } from '#src/waf/waf';

const withMarker = { writeReloadMarker: () => {} };

describe('shouldEmitCopyReloadMarker', () => {
	it('emits for a user table that received copied rows in this pass', () => {
		const copied = new Set(['dog']);
		expect(shouldEmitCopyReloadMarker(false, 'dog', withMarker, copied)).to.equal(true);
	});

	it('does NOT emit for a user table that received zero copied rows (the over-emission fix)', () => {
		const copied = new Set(['dog']);
		// `cat` got no copy-apply row this pass — nothing invisible to recover, so no marker.
		expect(shouldEmitCopyReloadMarker(false, 'cat', withMarker, copied)).to.equal(false);
	});

	it('does NOT emit for any user table when no table received copied rows', () => {
		const copied = new Set();
		expect(shouldEmitCopyReloadMarker(false, 'dog', withMarker, copied)).to.equal(false);
	});

	it('always emits for system-DB reload tables, even with an empty copied-set', () => {
		// System reload tables are a fixed cluster-machinery list; they re-drive subscribers regardless.
		const copied = new Set();
		expect(shouldEmitCopyReloadMarker(true, 'hdb_nodes', withMarker, copied)).to.equal(true);
	});

	it('never emits for a table without a writeReloadMarker method', () => {
		const copied = new Set(['dog']);
		expect(shouldEmitCopyReloadMarker(false, 'dog', {}, copied)).to.equal(false);
		expect(shouldEmitCopyReloadMarker(false, 'dog', undefined, copied)).to.equal(false);
		// even a system table without the method cannot emit
		expect(shouldEmitCopyReloadMarker(true, 'hdb_nodes', {}, copied)).to.equal(false);
	});
});

describe('SYSTEM_RELOAD_TABLES', () => {
	it('names the WAF rule table, so a copy re-drives a matcher whose subscription survived it', () => {
		expect(SYSTEM_RELOAD_TABLES).to.include(WAF_RULE_TABLE);
		// a table emptied on the leader must still re-drive it, so the copied-set cannot gate this
		expect(shouldEmitCopyReloadMarker(true, WAF_RULE_TABLE, withMarker, new Set())).to.equal(true);
	});
});

describe('writeReloadMarkerWithRetry', () => {
	const FAST_RETRY = { initialMs: 2, maxMs: 4 };
	const until = async (condition) => {
		const deadline = Date.now() + 5000;
		while (!condition()) {
			if (Date.now() > deadline) throw new Error('timed out');
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
	};

	it('writes once when the first attempt commits', async () => {
		let writes = 0;
		writeReloadMarkerWithRetry(() => ({ writeReloadMarker: async () => void writes++ }), 'system.table', FAST_RETRY);
		await until(() => writes === 1);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(writes).to.equal(1);
	});

	it('retries a rejected and a synchronously thrown write until one commits, then stops', async () => {
		let writes = 0;
		const table = {
			writeReloadMarker() {
				writes++;
				if (writes === 1) throw new Error('synchronous failure');
				if (writes === 2) return Promise.reject(new Error('commit failure'));
			},
		};
		expect(() => writeReloadMarkerWithRetry(() => table, 'system.table', FAST_RETRY)).to.not.throw();
		await until(() => writes === 3);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(writes).to.equal(3);
	});

	it('keeps one pending retry per table when two copies fail, and a commit after the first ends it', async () => {
		let fail = true;
		let writes = 0;
		const table = {
			writeReloadMarker() {
				writes++;
				if (fail) throw new Error('commit failure');
			},
		};
		const slowRetry = { initialMs: 200, maxMs: 200, minMs: 200 };
		writeReloadMarkerWithRetry(() => table, 'system.table', slowRetry);
		writeReloadMarkerWithRetry(() => table, 'system.table', slowRetry);
		await until(() => writes === 2);
		await new Promise((resolve) => setTimeout(resolve, 5));
		fail = false;
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(writes).to.equal(3);
	});

	for (const status of ['closing', 'closed']) {
		it(`stops retrying once the store is ${status}`, async () => {
			let writes = 0;
			const table = {
				auditStore: { rootStore: { status } },
				writeReloadMarker() {
					writes++;
					throw new Error('store closed');
				},
			};
			writeReloadMarkerWithRetry(() => table, 'data.table', FAST_RETRY);
			await until(() => writes === 1);
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(writes).to.equal(1);
		});
	}

	it('stops retrying once the table is dropped from an open database', async () => {
		let writes = 0;
		const table = {
			auditStore: { rootStore: { status: 'open' } },
			writeReloadMarker() {
				writes++;
				throw new Error('table dropped');
			},
		};
		let live = table;
		writeReloadMarkerWithRetry(() => live, 'data.table', { initialMs: 2, maxMs: 2, minMs: 2 });
		await until(() => writes >= 2);
		live = undefined;
		await new Promise((resolve) => setTimeout(resolve, 10));
		const settled = writes;
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(writes).to.equal(settled);
	});
});
