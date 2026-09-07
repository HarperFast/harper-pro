import assert from 'node:assert';
import {
	connectReportAdvancesGeneration,
	deriveEffectiveLeader,
	getConfiguredRoutes,
	replaceConfiguredRoutes,
} from '#src/replication/subscriptionManager';

describe('subscription manager review fixes', () => {
	const previousRoutes = [...getConfiguredRoutes()];

	after(() => {
		replaceConfiguredRoutes(previousRoutes);
	});

	it('publishes a complete route replacement without changing the shared array identity', () => {
		const sharedRoutes = getConfiguredRoutes();
		const oldRoute = { name: 'old' };
		replaceConfiguredRoutes([oldRoute]);

		const nextRoutes = [{ name: 'new-a' }];
		nextRoutes.push({ name: 'new-b' });
		assert.deepEqual(sharedRoutes, [oldRoute]);

		replaceConfiguredRoutes(nextRoutes);
		assert.strictEqual(getConfiguredRoutes(), sharedRoutes);
		assert.deepEqual(sharedRoutes, nextRoutes);
	});

	it('keeps explicit persisted leadership authoritative', () => {
		assert.equal(
			deriveEffectiveLeader({
				persistedIsLeader: true,
				hasExplicitLeader: true,
				leaderName: 'other',
				nodeName: 'peer',
			}),
			true
		);
		assert.equal(
			deriveEffectiveLeader({
				persistedIsLeader: false,
				hasExplicitLeader: true,
				leaderName: 'peer',
				nodeName: 'peer',
			}),
			false
		);
	});

	it('derives leadership only from an explicit match or the absence of any candidate', () => {
		assert.equal(deriveEffectiveLeader({ hasExplicitLeader: true, leaderName: 'peer', nodeName: 'peer' }), true);
		assert.equal(deriveEffectiveLeader({ hasExplicitLeader: true, leaderName: 'other', nodeName: 'peer' }), false);
		assert.equal(deriveEffectiveLeader({ hasExplicitLeader: false, leaderName: 'peer', nodeName: 'peer' }), false);
		assert.equal(deriveEffectiveLeader({ hasExplicitLeader: false }), true);
	});

	it('advances generation only for an owning socket-open report', () => {
		const entry = { worker: { threadId: 7 } };
		assert.equal(connectReportAdvancesGeneration(entry, { opened: true, reportingThreadId: 7 }), true);
		assert.equal(connectReportAdvancesGeneration(entry, { reportingThreadId: 7 }), false);
		assert.equal(connectReportAdvancesGeneration(entry, { opened: true, reportingThreadId: 8 }), false);
		assert.equal(connectReportAdvancesGeneration(entry, { opened: true }), true);
		assert.equal(connectReportAdvancesGeneration({}, { opened: true, reportingThreadId: 7 }), false);
	});
});
