/**
 * Coverage for shouldCloseSendAuthWatch — the caller-side loop body the dynamic send-authorization
 * watch in replicationConnection.ts runs for every hdb_nodes change event on a subscriber's row.
 *
 * resolveNodeForSendAuth (resolveNodeForSendAuth.test.mjs) pins the row-vs-event-payload swap in
 * isolation; this file pins the loop built on top of it, which is what actually shipped the fix and
 * is otherwise unexercised by anything except the manual cloneNode 1008-count evidence in the PR
 * description: the reload-marker/patch/decode-blip cases never closing a live peer, a genuine delete
 * always closing, the bounded re-probe grace period before failing closed on a persistently
 * undecodable row, and — per gemini-code-assist's review on PR #602 — never acting on a stale
 * resolution once the connection has closed while the async re-probe was suspended.
 */

import { expect } from 'chai';
import { shouldCloseSendAuthWatch } from '#src/replication/replicationConnection';
import { SEND_AUTH_UNCHANGED } from '#src/replication/knownNodes';

const neverClosed = () => false;
const noSleep = () => Promise.resolve();

describe('shouldCloseSendAuthWatch', () => {
	it('does not close for a reload marker while the peer is still authorized', async () => {
		const record = { name: 'node-a', replicates: true };
		const shouldClose = await shouldCloseSendAuthWatch({ type: 'reload' }, 'node-a', 'data', {
			isClosed: neverClosed,
			resolve: () => record,
		});
		expect(shouldClose).to.equal(false);
	});

	it('does not close for a patch that carries no replicates but the row is still authorized', async () => {
		const record = { name: 'node-a', replicates: { receives: true } };
		const shouldClose = await shouldCloseSendAuthWatch({ type: 'patch' }, 'node-a', 'data', {
			isClosed: neverClosed,
			resolve: () => record,
		});
		expect(shouldClose).to.equal(false);
	});

	it('closes on a genuine delete event without reading the row', async () => {
		let probed = false;
		const shouldClose = await shouldCloseSendAuthWatch({ type: 'delete' }, 'node-a', 'data', {
			isClosed: neverClosed,
			resolve: () => {
				probed = true;
				return { name: 'node-a', replicates: true };
			},
		});
		expect(shouldClose).to.equal(true);
		expect(probed).to.equal(false);
	});

	it('closes when the authoritative row no longer authorizes the peer', async () => {
		const record = { name: 'node-a', replicates: false };
		const shouldClose = await shouldCloseSendAuthWatch({ type: 'put' }, 'node-a', 'data', {
			isClosed: neverClosed,
			resolve: () => record,
		});
		expect(shouldClose).to.equal(true);
	});

	it('re-probes an undecodable row and stops closing once it resolves to an authorizing record', async () => {
		let calls = 0;
		const shouldClose = await shouldCloseSendAuthWatch({ type: 'put' }, 'node-a', 'data', {
			isClosed: neverClosed,
			sleep: noSleep,
			resolve: () => {
				calls++;
				return calls < 3 ? SEND_AUTH_UNCHANGED : { name: 'node-a', replicates: true };
			},
		});
		expect(shouldClose).to.equal(false);
		expect(calls).to.equal(3);
	});

	it('fails closed once the reprobe grace period is exhausted on a persistently undecodable row', async () => {
		let timedOut = false;
		const shouldClose = await shouldCloseSendAuthWatch({ type: 'put' }, 'node-a', 'data', {
			isClosed: neverClosed,
			sleep: noSleep,
			reprobeAttempts: 3,
			resolve: () => SEND_AUTH_UNCHANGED,
			onReprobeTimeout: () => {
				timedOut = true;
			},
		});
		expect(shouldClose).to.equal(true);
		expect(timedOut).to.equal(true);
	});

	it('does not close if the connection closes while the reprobe loop is still suspended', async () => {
		let closed = false;
		let timedOut = false;
		const shouldClose = await shouldCloseSendAuthWatch({ type: 'put' }, 'node-a', 'data', {
			isClosed: () => closed,
			sleep: async () => {
				closed = true;
			},
			resolve: () => SEND_AUTH_UNCHANGED,
			onReprobeTimeout: () => {
				timedOut = true;
			},
		});
		expect(shouldClose).to.equal(false);
		expect(timedOut).to.equal(false);
	});

	it('does not close if the connection closes after the row resolves but before the auth check runs', async () => {
		// Regression for gemini-code-assist's review on PR #602: a resolution that lands just as the
		// connection tears down must not trigger a redundant close/warn.
		let closed = false;
		const shouldClose = await shouldCloseSendAuthWatch({ type: 'put' }, 'node-a', 'data', {
			isClosed: () => closed,
			resolve: () => {
				closed = true;
				return { name: 'node-a', replicates: false };
			},
		});
		expect(shouldClose).to.equal(false);
	});
});
