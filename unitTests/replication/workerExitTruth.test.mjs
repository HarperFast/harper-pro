/**
 * Coverage for R1 (harper-pro#431): correcting connection truth when the worker that owned a (database,
 * peer) subscription is gone. A dead worker cannot write its own DOWN — that is the defect — so the buffer
 * keeps its last CONNECTED stamp and only reads down once liveness ages past LIVENESS_STALE_MS (>= 120s).
 *
 * Two writers, guarded identically, both exercised here:
 *  - `clearWorkerFromEntries`' owned-entry callback, invoked from the worker 'exit' handler BEFORE the
 *    ownership reference is dropped, so the stamp provably cannot land on a successor.
 *  - `hasLiveOwner`, the predicate the reconcile tick applies per entry to cover a worker which wedged or
 *    left the pool without its 'exit' ever firing.
 *
 * The invariant both share: an entry whose owner is a LIVE worker is never stamped, and the stamp itself
 * only ever overwrites a CONNECTED state — so a successor that has already re-stamped the link cannot be
 * downed by a late fire of either writer.
 */

import { expect } from 'chai';
import {
	stampWorkerExitDown,
	WORKER_EXIT_ERROR_CODE,
	CONNECTION_STATE_POSITION,
	LAST_LIVENESS_TIME_POSITION,
	LAST_ERROR_CODE_POSITION,
	LAST_ERROR_TIME_POSITION,
	CONNECTION_STATE_DOWN,
	CONNECTION_STATE_CONNECTED,
	deriveConnectionTruth,
} from '#src/replication/replicationConnection';
import { clearWorkerFromEntries, hasLiveOwner } from '#src/replication/subscriptionManager';
import { REPLICATION_SHARED_STATUS_SLOTS } from '#src/replication/knownNodes';

const NOW = 1_700_000_000_000;

function connectedStatus(liveness = NOW - 1000) {
	const status = new Float64Array(REPLICATION_SHARED_STATUS_SLOTS);
	status[CONNECTION_STATE_POSITION] = CONNECTION_STATE_CONNECTED;
	status[LAST_LIVENESS_TIME_POSITION] = liveness;
	return status;
}

// Map<url, Map<database, entry>>, matching connectionReplicationMap's shape.
function makeMap(spec) {
	const map = new Map();
	for (const [url, databases] of Object.entries(spec)) {
		const dbMap = new Map();
		for (const [database, { worker, nodeName }] of Object.entries(databases)) {
			dbMap.set(database, { worker, nodes: [{ name: nodeName }] });
		}
		map.set(url, dbMap);
	}
	return map;
}

describe('stampWorkerExitDown', () => {
	it('writes DOWN with the distinct worker-exit code and time', () => {
		const status = connectedStatus();
		expect(stampWorkerExitDown(status, NOW)).to.equal(true);
		expect(status[CONNECTION_STATE_POSITION]).to.equal(CONNECTION_STATE_DOWN);
		expect(status[LAST_ERROR_CODE_POSITION]).to.equal(WORKER_EXIT_ERROR_CODE);
		expect(status[LAST_ERROR_TIME_POSITION]).to.equal(NOW);
	});

	it('uses a code outside the 16-bit WebSocket close-code space so it cannot collide with a real one', () => {
		expect(WORKER_EXIT_ERROR_CODE).to.be.greaterThan(65535);
	});

	it('leaves liveness in place as the record of when the dead link was last proven alive', () => {
		const status = connectedStatus(NOW - 5000);
		stampWorkerExitDown(status, NOW);
		expect(status[LAST_LIVENESS_TIME_POSITION]).to.equal(NOW - 5000);
	});

	it('makes truth read not-connected immediately, without waiting for liveness to go stale', () => {
		const status = connectedStatus(NOW - 1000);
		expect(deriveConnectionTruth(status, NOW).connected).to.equal(true);
		stampWorkerExitDown(status, NOW);
		const truth = deriveConnectionTruth(status, NOW);
		expect(truth.connected).to.equal(false);
		expect(truth.errorCode).to.equal(WORKER_EXIT_ERROR_CODE);
	});

	it('does not overwrite a state that is not CONNECTED, so a real close code survives', () => {
		const status = new Float64Array(REPLICATION_SHARED_STATUS_SLOTS);
		status[CONNECTION_STATE_POSITION] = CONNECTION_STATE_DOWN;
		status[LAST_ERROR_CODE_POSITION] = 1006;
		expect(stampWorkerExitDown(status, NOW)).to.equal(false);
		expect(status[LAST_ERROR_CODE_POSITION]).to.equal(1006);
	});

	it('is a no-op without a buffer', () => {
		expect(stampWorkerExitDown(undefined, NOW)).to.equal(false);
	});
});

describe('clearWorkerFromEntries owned-entry callback (R1 exit-handler writer)', () => {
	it('reports every (database, peer) the dead worker owned, and nothing another worker owns', () => {
		const dead = { id: 'dead' };
		const live = { id: 'live' };
		const map = makeMap({
			'wss://a': { data: { worker: dead, nodeName: 'a' }, system: { worker: live, nodeName: 'a' } },
			'wss://b': { data: { worker: dead, nodeName: 'b' } },
		});

		const stamped = [];
		expect(clearWorkerFromEntries(map, dead, (database, nodeName) => stamped.push(`${database}/${nodeName}`))).to.equal(
			true
		);
		expect(stamped).to.deep.equal(['data/a', 'data/b']);
	});

	it('fires the callback while the dead worker is still the recorded owner', () => {
		const dead = { id: 'dead' };
		const map = makeMap({ 'wss://a': { data: { worker: dead, nodeName: 'a' } } });
		const entry = map.get('wss://a').get('data');

		let ownerAtCallback;
		clearWorkerFromEntries(map, dead, () => (ownerAtCallback = entry.worker));

		expect(ownerAtCallback).to.equal(dead);
		expect(entry.worker).to.equal(undefined);
	});

	it('is optional — the pre-existing two-argument call still clears ownership', () => {
		const dead = { id: 'dead' };
		const map = makeMap({ 'wss://a': { data: { worker: dead, nodeName: 'a' } } });
		expect(clearWorkerFromEntries(map, dead)).to.equal(true);
		expect(map.get('wss://a').get('data').worker).to.equal(undefined);
	});
});

describe('hasLiveOwner (R1 reconcile-tick guard)', () => {
	it('is true only for an entry whose worker is in the live pool', () => {
		const live = { id: 'live' };
		expect(hasLiveOwner({ worker: live }, [live])).to.equal(true);
	});

	it('is false for an entry whose worker has left the pool — the state R1 stamps', () => {
		expect(hasLiveOwner({ worker: { id: 'dead' } }, [{ id: 'live' }])).to.equal(false);
	});

	it('is false for an entry with no worker at all (assignment never landed, or exit already cleared it)', () => {
		expect(hasLiveOwner({ worker: undefined }, [{ id: 'live' }])).to.equal(false);
	});

	it('is false with an empty pool — no live worker means no live owner for anything', () => {
		expect(hasLiveOwner({ worker: { id: 'dead' } }, [])).to.equal(false);
	});
});
