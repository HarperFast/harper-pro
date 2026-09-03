/**
 * The fence exists because a socket that has already been replaced can still have a message in flight,
 * and because the entry must never keep a retired session's capabilities standing for a live one.
 */
import assert from 'node:assert';
import { applyConnectionMetadata } from '#src/replication/subscriptionManager';

const CAPABILITIES_A = Object.freeze({
	protocolVersion: 2,
	subscriptionSetupAck: 1,
	subscriptionSetupBudgetMs: 90_000,
});
const CAPABILITIES_LEGACY = Object.freeze({
	protocolVersion: 1,
	subscriptionSetupAck: 0,
	subscriptionSetupBudgetMs: undefined,
});

function entryOwnedBy(threadId) {
	return { worker: { threadId }, connected: true };
}

function post(threadId, sessionOrdinal, extra) {
	return { name: 'peer', database: 'data', url: 'wss://peer:9933', threadId, sessionOrdinal, ...extra };
}

describe('applyConnectionMetadata', () => {
	it('ignores a message that carries no protocol metadata', () => {
		const entry = entryOwnedBy(3);
		assert.strictEqual(applyConnectionMetadata(entry, post(3, 1)), false);
		assert.strictEqual('peerCapabilities' in entry, false);
	});

	it('applies capabilities from the worker that owns the entry', () => {
		const entry = entryOwnedBy(3);
		assert.strictEqual(applyConnectionMetadata(entry, post(3, 1, { peerCapabilities: CAPABILITIES_A })), true);
		assert.strictEqual(entry.peerCapabilities, CAPABILITIES_A);
	});

	it('rejects a message from a worker that does not own the entry', () => {
		const entry = entryOwnedBy(3);
		assert.strictEqual(applyConnectionMetadata(entry, post(9, 1, { peerCapabilities: CAPABILITIES_A })), false);
		assert.strictEqual(entry.peerCapabilities, undefined);
	});

	it('rejects a late message from a superseded session in the owning worker', () => {
		const entry = entryOwnedBy(3);
		applyConnectionMetadata(entry, post(3, 7, { peerCapabilities: CAPABILITIES_A }));
		// The replaced socket's NODE_NAME finally lands, carrying the previous peer's legacy capabilities.
		assert.strictEqual(applyConnectionMetadata(entry, post(3, 6, { peerCapabilities: CAPABILITIES_LEGACY })), false);
		assert.strictEqual(entry.peerCapabilities, CAPABILITIES_A);
	});

	it('accepts a later post from the same session, so a pong can carry a changed counter', () => {
		const entry = entryOwnedBy(3);
		applyConnectionMetadata(entry, post(3, 7, { peerCapabilities: CAPABILITIES_A }));
		assert.strictEqual(applyConnectionMetadata(entry, post(3, 7, { unknownCommandFrames: 4 })), true);
		assert.strictEqual(entry.unknownCommandFrames, 4);
		assert.strictEqual(entry.peerCapabilities, CAPABILITIES_A, 'a counter-only post leaves capabilities alone');
	});

	it('restarts the ordinal sequence when the entry is reassigned to another worker', () => {
		const entry = entryOwnedBy(3);
		applyConnectionMetadata(entry, post(3, 42, { peerCapabilities: CAPABILITIES_A }));
		// Failover/reassignment: the main thread rebinds the entry, and the new worker's ordinals start low.
		entry.worker = { threadId: 9 };
		assert.strictEqual(applyConnectionMetadata(entry, post(9, 1, { peerCapabilities: CAPABILITIES_LEGACY })), true);
		assert.strictEqual(entry.peerCapabilities, CAPABILITIES_LEGACY);
		// …and the old worker still cannot write to it afterwards.
		assert.strictEqual(applyConnectionMetadata(entry, post(3, 43, { peerCapabilities: CAPABILITIES_A })), false);
		assert.strictEqual(entry.peerCapabilities, CAPABILITIES_LEGACY);
	});

	it('clears a retired session capabilities when a new session posts without any', () => {
		// A reconnected socket posts its zero unknown-frame count before its NODE_NAME lands. If that post
		// only advanced the fence, the entry would keep reporting the retired session's bag against a link
		// that has learned nothing — and the same pong marks the link connected, so nothing else masks it.
		const entry = entryOwnedBy(3);
		applyConnectionMetadata(entry, post(3, 1, { peerCapabilities: CAPABILITIES_A }));
		assert.strictEqual(entry.peerCapabilities, CAPABILITIES_A);
		assert.strictEqual(applyConnectionMetadata(entry, post(3, 2, { unknownCommandFrames: 0 })), true);
		assert.strictEqual(entry.peerCapabilities, undefined, 'the new session has learned nothing yet');
		// …and the same session's later handshake post fills it back in.
		assert.strictEqual(applyConnectionMetadata(entry, post(3, 2, { peerCapabilities: CAPABILITIES_LEGACY })), true);
		assert.strictEqual(entry.peerCapabilities, CAPABILITIES_LEGACY);
	});

	it('keeps capabilities when the SAME session posts a counter-only update', () => {
		// Only a new session means "not learned yet"; a pong from the session that already handshook must
		// not blank what that handshake established.
		const entry = entryOwnedBy(3);
		applyConnectionMetadata(entry, post(3, 5, { peerCapabilities: CAPABILITIES_A }));
		assert.strictEqual(applyConnectionMetadata(entry, post(3, 5, { unknownCommandFrames: 3 })), true);
		assert.strictEqual(entry.peerCapabilities, CAPABILITIES_A);
		assert.strictEqual(entry.unknownCommandFrames, 3);
	});

	it('ignores a connect-edge post, leaving the newSocket clear to connectedToNode', () => {
		// The connect edge carries no fence, so this helper must decline it; clearing on the open edge is
		// connectedToNode's job, and routing it through here would also catch reconcile up-corrections,
		// which replay the same path on a live socket.
		const entry = entryOwnedBy(3);
		applyConnectionMetadata(entry, post(3, 1, { peerCapabilities: CAPABILITIES_A }));
		assert.strictEqual(
			applyConnectionMetadata(entry, { name: 'peer', database: 'data', url: 'wss://peer:9933', newSocket: true }),
			false
		);
		assert.strictEqual(entry.peerCapabilities, CAPABILITIES_A);
	});

	it('clears capabilities when the entry is reassigned to a worker that has learned nothing', () => {
		const entry = entryOwnedBy(3);
		applyConnectionMetadata(entry, post(3, 1, { peerCapabilities: CAPABILITIES_A }));
		entry.worker = { threadId: 9 };
		assert.strictEqual(applyConnectionMetadata(entry, post(9, 1, { unknownCommandFrames: 0 })), true);
		assert.strictEqual(entry.peerCapabilities, undefined);
	});

	it('accepts metadata for an entry with no worker bound yet', () => {
		const entry = { connected: true };
		assert.strictEqual(applyConnectionMetadata(entry, post(3, 1, { peerCapabilities: CAPABILITIES_A })), true);
		assert.strictEqual(entry.peerCapabilities, CAPABILITIES_A);
	});

	it('lets a reconnected socket clear the retired socket count by posting its own zero', () => {
		// A new socket that has seen no unrecognized frame must publish `unknownCommandFrames: 0`, or
		// cluster_status keeps reporting the retired socket's count against a healthy link.
		const entry = entryOwnedBy(3);
		applyConnectionMetadata(entry, post(3, 1, { unknownCommandFrames: 2 }));
		assert.strictEqual(entry.unknownCommandFrames, 2);
		assert.strictEqual(
			applyConnectionMetadata(entry, post(3, 2, { peerCapabilities: CAPABILITIES_A, unknownCommandFrames: 0 })),
			true
		);
		assert.strictEqual(entry.unknownCommandFrames, 0);
	});

	it('replaces capabilities when the same socket relearns a downgraded peer', () => {
		const entry = entryOwnedBy(3);
		applyConnectionMetadata(entry, post(3, 1, { peerCapabilities: CAPABILITIES_A }));
		assert.strictEqual(applyConnectionMetadata(entry, post(3, 2, { peerCapabilities: CAPABILITIES_LEGACY })), true);
		assert.strictEqual(entry.peerCapabilities, CAPABILITIES_LEGACY);
	});
});
