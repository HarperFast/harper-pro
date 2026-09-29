import assert from 'node:assert';
import {
	advanceConnectGeneration,
	attachSelfCatchupNode,
	claimRecovery,
	connectReportAdvancesGeneration,
	deriveEffectiveLeader,
	getConfiguredRoutes,
	pendingSelfCatchupNode,
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

	it('advances generation only for the owning primary socket-open edge', () => {
		const entry = { worker: { threadId: 7 }, nodes: [{ url: 'wss://primary:9933' }] };
		const open = { newSocket: true, threadId: 7, subscriptionUrl: 'wss://primary:9933' };
		assert.equal(connectReportAdvancesGeneration(entry, open), true);
		assert.equal(connectReportAdvancesGeneration(entry, { threadId: 7, subscriptionUrl: 'wss://primary:9933' }), false);
		assert.equal(connectReportAdvancesGeneration(entry, { ...open, threadId: 8 }), false);
		assert.equal(connectReportAdvancesGeneration(entry, { ...open, subscriptionUrl: 'wss://proxied:9933' }), false);
		assert.equal(connectReportAdvancesGeneration({ nodes: entry.nodes }, { ...open, threadId: 0 }), true);
	});

	it('restarts the stall grace and hands the catchup rider to the worker on a new connection', () => {
		const rider = { name: 'self', startTime: 123, endTime: 456, replicates: true };
		const entry = { selfCatchupNode: rider, connectGeneration: 2, receiveStallReconnectAt: 50 };
		assert.strictEqual(pendingSelfCatchupNode(entry), rider);
		advanceConnectGeneration(entry, 100, 900);
		assert.equal(entry.connectGeneration, 3);
		assert.equal(entry.receiveStallReconnectAt, undefined);
		assert.equal(entry.receiveStallGraceUntil, 1000);
		assert.equal(pendingSelfCatchupNode(entry), undefined);
		assert.strictEqual(entry.selfCatchupNode, rider);
	});

	it('re-sends the catchup rider to a replacement worker after the first one opened with it', () => {
		const rider = { name: 'self', startTime: 123, endTime: 456, replicates: true };
		const opened = { selfCatchupNode: rider };
		advanceConnectGeneration(opened, 100, 900);
		const recreated = { selfCatchupNode: opened.selfCatchupNode };
		assert.strictEqual(pendingSelfCatchupNode(recreated), rider);
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
