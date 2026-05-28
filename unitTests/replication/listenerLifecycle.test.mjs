/**
 * Regression coverage for the `MaxListenersExceededWarning` triggered by replication's
 * `updateTable` listener registrations on the global `databaseEventsEmitter`.
 *
 * Two distinct bugs were addressed:
 *
 *   1) Leak — `knownNodes.startSubscriptionToReplications` previously called
 *      `forEachReplicatedDatabase` inside the per-node-update callback and discarded
 *      the returned remove handle. Every node-table update therefore added 2 listeners
 *      (`updateTable` + `dropDatabase`) on the global emitter, accumulating without
 *      bound. The fix tracks the handle per node and calls remove() before installing
 *      a new one for the same node. A pure-iteration helper `iterateReplicatedDatabases`
 *      is also exported for callers that genuinely don't need future-DB watching.
 *
 *   2) Config — even with the leak fixed, a multi-peer cluster legitimately registers
 *      one listener per active connection (subscriptionManager + replicationConnection),
 *      easily exceeding Node's default 10. `replicator.ts` now calls
 *      `databaseEventsEmitter.setMaxListeners(1000)` at module load.
 *
 * This test asserts both invariants at the function level without spinning up a full
 * Harper integration cluster.
 */

import { expect } from 'chai';
import { databaseEventsEmitter } from '#src/core/resources/databases';
import { forEachReplicatedDatabase, iterateReplicatedDatabases } from '#src/replication/replicator';

const UPDATE_TABLE = 'updateTable';
const DROP_DATABASE = 'dropDatabase';

describe('replication listener lifecycle on databaseEventsEmitter', () => {
	it('raises setMaxListeners well above Node default so multi-peer fan-out does not warn', () => {
		// If this drops back to <= 10 someone removed the cap in replicator.ts and the
		// MaxListenersExceededWarning will return under high connection counts.
		expect(databaseEventsEmitter.getMaxListeners()).to.be.at.least(1000);
	});

	it('iterateReplicatedDatabases registers no listeners (no leak when called per node update)', () => {
		const beforeUpdate = databaseEventsEmitter.listenerCount(UPDATE_TABLE);
		const beforeDrop = databaseEventsEmitter.listenerCount(DROP_DATABASE);

		// Call many times to mimic many node-table updates firing through
		// startSubscriptionToReplications — the previous implementation leaked 2 listeners
		// per call here.
		for (let i = 0; i < 25; i++) {
			iterateReplicatedDatabases({}, () => {});
		}

		expect(databaseEventsEmitter.listenerCount(UPDATE_TABLE)).to.equal(beforeUpdate);
		expect(databaseEventsEmitter.listenerCount(DROP_DATABASE)).to.equal(beforeDrop);
	});

	it('forEachReplicatedDatabase adds exactly one updateTable + one dropDatabase listener, both removed on remove()', () => {
		const beforeUpdate = databaseEventsEmitter.listenerCount(UPDATE_TABLE);
		const beforeDrop = databaseEventsEmitter.listenerCount(DROP_DATABASE);

		const handle = forEachReplicatedDatabase({}, () => {});

		expect(databaseEventsEmitter.listenerCount(UPDATE_TABLE)).to.equal(beforeUpdate + 1);
		expect(databaseEventsEmitter.listenerCount(DROP_DATABASE)).to.equal(beforeDrop + 1);

		handle.remove();

		expect(databaseEventsEmitter.listenerCount(UPDATE_TABLE)).to.equal(beforeUpdate);
		expect(databaseEventsEmitter.listenerCount(DROP_DATABASE)).to.equal(beforeDrop);
	});

	it('repeated forEachReplicatedDatabase / remove cycles return listener count to baseline (no asymmetric leak)', () => {
		const beforeUpdate = databaseEventsEmitter.listenerCount(UPDATE_TABLE);
		const beforeDrop = databaseEventsEmitter.listenerCount(DROP_DATABASE);

		for (let i = 0; i < 25; i++) {
			const handle = forEachReplicatedDatabase({}, () => {});
			handle.remove();
		}

		expect(databaseEventsEmitter.listenerCount(UPDATE_TABLE)).to.equal(beforeUpdate);
		expect(databaseEventsEmitter.listenerCount(DROP_DATABASE)).to.equal(beforeDrop);
	});

	it('regression: discarding remove handles WOULD leak — keeping handles and removing them does NOT', () => {
		// This test pins the failure mode. If the per-node-update site in knownNodes.ts ever
		// regresses to forEachReplicatedDatabase({}, cb) without tracking the handle, the
		// "without cleanup" arm here would have grown listener count by 50; the "with cleanup"
		// arm proves the fix's discipline returns to baseline.
		const beforeUpdate = databaseEventsEmitter.listenerCount(UPDATE_TABLE);

		// Confirm the leak pattern: discarding the handle 25 times leaks 25 listeners.
		const leakHandles = [];
		for (let i = 0; i < 25; i++) {
			leakHandles.push(forEachReplicatedDatabase({}, () => {}));
		}
		expect(databaseEventsEmitter.listenerCount(UPDATE_TABLE)).to.equal(beforeUpdate + 25);
		for (const handle of leakHandles) handle.remove();
		expect(databaseEventsEmitter.listenerCount(UPDATE_TABLE)).to.equal(beforeUpdate);

		// Now exercise the production pattern: replace previous handle for the same logical
		// key before installing a new one. Listener count stays bounded at 1.
		let activeHandle;
		for (let i = 0; i < 25; i++) {
			activeHandle?.remove();
			activeHandle = forEachReplicatedDatabase({}, () => {});
		}
		expect(databaseEventsEmitter.listenerCount(UPDATE_TABLE)).to.equal(beforeUpdate + 1);
		activeHandle.remove();
		expect(databaseEventsEmitter.listenerCount(UPDATE_TABLE)).to.equal(beforeUpdate);
	});

	it('25 concurrently-held forEachReplicatedDatabase handles do not warn (config cap defends fan-out)', () => {
		const warnings = [];
		const captureWarning = (warning) => {
			if (warning?.name === 'MaxListenersExceededWarning') warnings.push(warning);
		};
		process.on('warning', captureWarning);

		const handles = [];
		try {
			for (let i = 0; i < 25; i++) {
				handles.push(forEachReplicatedDatabase({}, () => {}));
			}
			// Give the warning machinery a tick to surface anything queued.
			return new Promise((resolve) => setImmediate(resolve)).then(() => {
				expect(warnings, JSON.stringify(warnings.map((w) => w.message))).to.have.lengthOf(0);
			});
		} finally {
			for (const handle of handles) handle.remove();
			process.off('warning', captureWarning);
		}
	});
});
