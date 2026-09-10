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
import { shouldEmitCopyReloadMarker } from '#src/replication/replicationConnection';

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
