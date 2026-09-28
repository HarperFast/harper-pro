import assert from 'node:assert';
import {
	applyOwningConnectionOpen,
	attachSelfCatchupNode,
	claimRecovery,
	connectReportAdvancesGeneration,
	deriveEffectiveLeader,
	getConfiguredRoutes,
	replaceConfiguredRoutes,
} from '#src/replication/subscriptionManager';

describe('subscription routing and connection ownership', () => {
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
		const entry = { worker: { threadId: 7 }, nodes: [{ url: 'wss://primary:9933' }] };
		assert.equal(
			connectReportAdvancesGeneration(entry, {
				opened: true,
				reportingThreadId: 7,
				subscriptionUrl: 'wss://primary:9933',
			}),
			true
		);
		assert.equal(connectReportAdvancesGeneration(entry, { reportingThreadId: 7 }), false);
		assert.equal(
			connectReportAdvancesGeneration(entry, {
				opened: true,
				reportingThreadId: 8,
				subscriptionUrl: 'wss://primary:9933',
			}),
			false
		);
		assert.equal(
			connectReportAdvancesGeneration(entry, {
				opened: true,
				reportingThreadId: 7,
				subscriptionUrl: 'wss://proxied:9933',
			}),
			false
		);
		assert.equal(connectReportAdvancesGeneration(entry, { opened: true }), true);
		assert.equal(connectReportAdvancesGeneration({}, { opened: true, reportingThreadId: 7 }), false);
	});

	it('retires main-thread catchup ownership only when the primary connection opens', () => {
		const rider = { name: 'self', startTime: 123, endTime: 456, replicates: true };
		const entry = {
			worker: { threadId: 7 },
			nodes: [{ url: 'wss://primary:9933' }],
			selfCatchupNode: rider,
			connectGeneration: 2,
			receiveStallReconnectAt: 50,
		};

		assert.equal(
			applyOwningConnectionOpen(
				entry,
				{ opened: true, reportingThreadId: 7, subscriptionUrl: 'wss://proxied:9933' },
				100,
				900
			),
			false
		);
		assert.strictEqual(entry.selfCatchupNode, rider);
		assert.equal(entry.connectGeneration, 2);

		assert.equal(
			applyOwningConnectionOpen(
				entry,
				{ opened: true, reportingThreadId: 7, subscriptionUrl: 'wss://primary:9933' },
				100,
				900
			),
			true
		);
		assert.equal(entry.selfCatchupNode, undefined);
		assert.equal(entry.connectGeneration, 3);
		assert.equal(entry.receiveStallReconnectAt, undefined);
		assert.equal(entry.receiveStallGraceUntil, 1000);
	});

	it('reattaches retained self-catchup state to a direct recovery payload', () => {
		const nodes = [{ name: 'peer' }];
		const selfCatchupNode = { name: 'self', startTime: 123, endTime: 456, replicates: true };
		assert.deepEqual(attachSelfCatchupNode(nodes, selfCatchupNode), [...nodes, selfCatchupNode]);
	});

	it('preserves an armed recovery and its original ownership stamp', () => {
		const timer = {};
		const entry = { disconnectedAt: 100, reDriveTimer: timer };
		assert.equal(claimRecovery(entry, 'disconnectedAt', 200), false);
		assert.equal(entry.disconnectedAt, 100);
		assert.strictEqual(entry.reDriveTimer, timer);
	});
});
