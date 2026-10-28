const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const req = createRequire(path.resolve(__dirname, '../../../../package.json'));
const base = require('../../../../core/unitTests/resources/fixtures/slotRetryAbort.cjs');
exports.snapshot = (Records, id = 'retry-abort') => ({
	...base.snapshot(Records, id),
	scoreIndex: [...Records.indices.score.getRange({})].filter((e) => e.value === id),
});
exports.audit = base.audit;
exports.abortMove = async (Records, api) => {
	const { transaction, Transaction, constants, setResidencyPlacementGuard, replicationConfirmation } = api;
	const { REPLICATION_APPLY } = req('#src/core/resources/databaseLiveGuard');
	const marker = process.env.PROBE_MARKER ?? 'missing';
	if (marker !== 'native')
		Object.defineProperty(Transaction.prototype, 'usesAbortMarkers', {
			configurable: true,
			value: marker === 'missing' ? undefined : () => marker === 'true',
		});
	const binding = Object.values(require.cache).find(
		(m) => m.filename?.endsWith('.node') && typeof m.exports.forceTryAgainForTesting === 'function'
	)?.exports;
	assert.ok(binding);
	const id = 'retry-abort';
	const start = Date.now();
	await transaction({ timestamp: start - 10_000 }, () =>
		Records.put(id, { id, region: 0, zone: 0, score: 1, body: 'original', other: 'original-other' })
	);
	const concurrentRecord = { id, region: 2, zone: 1, score: 2, body: 'concurrent', other: 'concurrent-other' };
	const submitted = process.env.PROBE_PATCH === 'body' ? { body: 'submitted' } : { score: 3, body: 'submitted' };
	const nativeCommit = Transaction.prototype.commit,
		nativeAbort = Transaction.prototype.abort;
	const attempts = [],
		aborts = [],
		confirmations = [];
	let originalId, admittedSlot, concurrent, error;
	const context = { timestamp: start };
	Transaction.prototype.abort = function (...args) {
		const item = { id: this.id };
		aborts.push(item);
		try {
			return nativeAbort.apply(this, args);
		} catch (e) {
			Object.assign(item, { code: e.code, message: e.message });
			throw e;
		}
	};
	Transaction.prototype.commit = function (...args) {
		if (this.store?.db !== Records.primaryStore.store.db) return nativeCommit.apply(this, args);
		attempts.push(this.id);
		const first = originalId === undefined;
		if (first) originalId = this.id;
		const result = nativeCommit.apply(this, args);
		if (!first) return result;
		const changeBase = async () => {
			if (process.env.PROBE_BASE === 'put') {
				await transaction({}, () => Records.put(id, concurrentRecord));
			} else {
				const apply = { sourceApply: true, [REPLICATION_APPLY]: true };
				await transaction(apply, async () => {
					const row = await Records.getResource(id, apply);
					await row._writeUpdate(id, concurrentRecord, true, {
						isCopyApply: true,
						isNotification: true,
						version: start - 1_000,
						nodeId: req('#src/core/resources/nodeIdMapping').getIdOfRemoteNode('slot1-owner', Records.auditStore),
					});
				});
			}
			concurrent = exports.snapshot(Records);
			assert.equal(concurrent.slot, 1);
			assert.equal(concurrent.flags & 1, 1);
			assert.equal(concurrent.value.body, undefined);
		};
		return result.then(
			async (outcome) => {
				assert.equal(outcome, constants.RETRY_NOW_VALUE);
				await changeBase();
				return outcome;
			},
			async (e) => {
				assert.equal(e.code, 'ERR_TRY_AGAIN');
				await changeBase();
				throw e;
			}
		);
	};
	setResidencyPlacementGuard(() => {});
	replicationConfirmation((...args) => {
		confirmations.push(args);
		return Promise.resolve();
	});
	try {
		try {
			await transaction(context, async () => {
				await Records.patch(id, submitted);
				const write = context.transaction.writes.find((w) => w?.key === id);
				admittedSlot = write.residencyOwnerSlot;
				assert.equal(admittedSlot, Records.residency.byAttribute ? 0 : Records.getResidencySlot(id));
				binding.forceTryAgainForTesting(1);
			});
		} catch (e) {
			error = { statusCode: e.statusCode, retryable: e.retryable, code: e.code, message: e.message };
		}
		return {
			marker,
			submitted,
			originalId,
			admittedSlot,
			attempts,
			aborts,
			confirmations,
			error,
			concurrentRecord,
			concurrent,
			primary: exports.snapshot(Records),
			committed: exports.audit(Records),
			uncommitted: exports.audit(Records, { readUncommitted: true }),
		};
	} finally {
		binding.forceTryAgainForTesting(0);
		Transaction.prototype.commit = nativeCommit;
		Transaction.prototype.abort = nativeAbort;
		setResidencyPlacementGuard(undefined);
		replicationConfirmation(undefined);
	}
};
