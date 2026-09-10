/**
 * Coverage for `isConnectionSuperseded` (harper-pro#683).
 *
 * Background: `forceReconnect`'s teardown of a wedged socket is best-effort and may never fire
 * 'close' (the #420 open-but-idle wedge), so `wsClosed` alone cannot tell a live closure from a
 * zombie one whose connection has already installed a replacement socket. A zombie acting on the
 * shared [copyCursor, nodeId] key (persist, or maybeFinishCopy's removal) or re-firing the
 * blob-gap watchdog would corrupt or churn the replacement's state. Ownership is therefore socket
 * identity on the shared connection object — the same test the close handler uses.
 */

import { expect } from 'chai';
import { isConnectionSuperseded } from '#src/replication/replicationConnection';

describe('isConnectionSuperseded (#683)', () => {
	const ws = { id: 'socket-a' };

	it('a live outbound closure is not superseded (connection still points at this socket)', () => {
		expect(isConnectionSuperseded(false, { socket: ws }, ws)).to.equal(false);
	});

	it('closed socket is always superseded, with or without a connection object', () => {
		expect(isConnectionSuperseded(true, { socket: ws }, ws)).to.equal(true);
		expect(isConnectionSuperseded(true, undefined, ws)).to.equal(true);
	});

	it('a replaced socket is superseded even though close never fired (the #420 wedge shape)', () => {
		const replacement = { id: 'socket-b' };
		expect(isConnectionSuperseded(false, { socket: replacement }, ws)).to.equal(true);
	});

	it('a connection whose socket was cleared is superseded', () => {
		expect(isConnectionSuperseded(false, { socket: undefined }, ws)).to.equal(true);
	});

	it('an inbound connection (no connection object) degrades to wsClosed', () => {
		expect(isConnectionSuperseded(false, undefined, ws)).to.equal(false);
		expect(isConnectionSuperseded(false, null, ws)).to.equal(false);
	});
});
