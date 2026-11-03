import { expect } from 'chai';
import { encode } from 'msgpackr';
import {
	CopyStallTracker,
	COPY_STALL_HOLD_MIN_MS,
	COPY_STALL_HOLD_MAX_MS,
	STUCK_COPY_HELD,
	STUCK_COPY_ORIGIN_REFUSED,
	STUCK_COPY_OWNER_REFUSED,
	STUCK_COPY_REFUSED,
	STUCK_COPY_RETRYING,
	copyStartKey,
	readStuckCopy,
} from '#src/replication/copyStall';
import { REPLICATION_SHARED_STATUS_SLOTS } from '#src/replication/sharedStatusSlots';
import { ownUnnamedOriginId, unnamedOriginName } from '#src/replication/unnamedOrigins';

// random just under 1 puts each jittered hold at its ceiling, so doubling is visible
function tracker(limit = 3) {
	let now = 1_000_000;
	const stall = new CopyStallTracker(limit, { random: () => 1 - Number.EPSILON, now: () => now });
	const status = new Float64Array(REPLICATION_SHARED_STATUS_SLOTS);
	stall.attachStatus(status);
	return { stall, status, advance: (ms) => (now += ms) };
}

describe('CopyStallTracker', () => {
	it('reports nothing for a healthy first attempt', () => {
		const { stall, status } = tracker();
		expect(stall.noteCopyStart('fresh')).to.equal(undefined);
		expect(stall.noteClosed().holdMs).to.equal(0);
		expect(readStuckCopy(status)).to.equal(undefined);
	});

	it('counts a copy that fails before its first checkpoint, from no cursor at all', () => {
		const { stall, status } = tracker(3);
		stall.noteCopyStart('fresh');
		expect(stall.noteClosed().holdMs).to.equal(0);
		expect(stall.noteCopyStart('fresh')).to.include({ to: STUCK_COPY_RETRYING, count: 2 });
		expect(stall.noteClosed().holdMs).to.equal(0);
		expect(stall.noteCopyStart('fresh')).to.equal(undefined, 'still retrying: no new transition');
		const closed = stall.noteClosed();
		expect(closed.holdMs).to.be.at.least(COPY_STALL_HOLD_MIN_MS);
		expect(closed.transition).to.include({ to: STUCK_COPY_HELD, count: 3 });
		expect(readStuckCopy(status)).to.include({ state: 'held', count: 3 });
		expect(readStuckCopy(status).retryAt).to.be.a('string');
	});

	it('keeps the held state and its since across the attempt after a hold, and doubles the hold', () => {
		const { stall, status, advance } = tracker(2);
		stall.noteCopyStart('k');
		stall.noteClosed();
		stall.noteCopyStart('k');
		const first = stall.noteClosed().holdMs;
		const since = readStuckCopy(status).since;
		advance(first);
		expect(stall.noteCopyStart('k')).to.equal(undefined, 'no held -> retrying flap');
		expect(readStuckCopy(status)).to.include({ state: 'held', count: 3, since });
		const second = stall.noteClosed();
		expect(second.transition).to.equal(undefined, 'already held: logged once');
		expect(first).to.equal(COPY_STALL_HOLD_MIN_MS);
		expect(second.holdMs).to.be.within(first * 2 - 1, first * 2);
	});

	it('caps the hold', () => {
		const { stall } = tracker(1);
		let holdMs = 0;
		for (let i = 0; i < 12; i++) {
			stall.noteCopyStart('k');
			holdMs = stall.noteClosed().holdMs;
		}
		expect(holdMs).to.be.at.most(COPY_STALL_HOLD_MAX_MS);
		expect(holdMs).to.be.above(COPY_STALL_HOLD_MAX_MS / 2);
	});

	it('starts over at a new position, which clears a hold reported for the old one', () => {
		const { stall, status } = tracker(2);
		stall.noteCopyStart('a');
		stall.noteClosed();
		stall.noteCopyStart('a');
		stall.noteClosed();
		expect(stall.state).to.equal(STUCK_COPY_HELD);
		expect(stall.noteCopyStart('b')).to.include({ from: STUCK_COPY_HELD, to: 0 });
		expect(stall.attempts).to.equal(1);
		expect(readStuckCopy(status)).to.equal(undefined);
		expect(stall.noteClosed().holdMs).to.equal(0);
	});

	it('does not count a cursor rewritten at the start position as progress', () => {
		const { stall } = tracker(2);
		const start = copyStartKey({ copyStartTime: 1, currentTable: 'T', afterKey: 'k' }, encode);
		stall.noteCopyStart(start);
		stall.noteClosed();
		stall.noteCopyStart(start);
		expect(stall.noteCursorPersisted(start)).to.equal(undefined);
		expect(stall.state).to.equal(STUCK_COPY_RETRYING);
		const moved = copyStartKey({ copyStartTime: 1, currentTable: 'T', afterKey: 'm' }, encode);
		expect(stall.noteCursorPersisted(moved)).to.include({ from: STUCK_COPY_RETRYING, to: 0 });
	});

	it('holds a refused copy from the first refusal and keeps refused over held', () => {
		const { stall, status } = tracker(2);
		expect(stall.noteRefusal(STUCK_COPY_OWNER_REFUSED)).to.include({ to: STUCK_COPY_REFUSED, count: 1 });
		expect(stall.noteClosed().holdMs).to.be.at.least(COPY_STALL_HOLD_MIN_MS);
		stall.noteCopyStart('fresh');
		stall.noteCopyStart('fresh');
		expect(stall.noteRefusal(STUCK_COPY_OWNER_REFUSED)).to.equal(undefined);
		stall.noteClosed();
		expect(readStuckCopy(status)).to.include({
			state: 'refused',
			reason: 'Owned sharding slots require a complete co-owner or backup restore',
			count: 2,
		});
		stall.noteOpened();
		expect(stall.noteSessionQuiet()).to.include({ from: STUCK_COPY_REFUSED, to: 0 });
		expect(readStuckCopy(status)).to.equal(undefined);
	});

	it('keeps the ordinary schedule for an origin refusal, which a sharding map change can clear', () => {
		const { stall, status } = tracker(2);
		expect(stall.noteRefusal(STUCK_COPY_ORIGIN_REFUSED)).to.include({ to: STUCK_COPY_REFUSED });
		expect(stall.noteClosed().holdMs).to.equal(0);
		expect(readStuckCopy(status)).to.include({ state: 'refused' });
	});

	it('holds a leg only for what the closing session did', () => {
		const { stall, status } = tracker(2);
		stall.noteCopyStart('k');
		stall.noteClosed();
		stall.noteCopyStart('k');
		expect(stall.noteClosed().holdMs).to.be.at.least(COPY_STALL_HOLD_MIN_MS);
		stall.noteOpened();
		expect(readStuckCopy(status).retryAt).to.equal(undefined, 'the hold it reported is over');
		expect(stall.noteClosed().holdMs).to.equal(0, 'a session that started no copy closed for another reason');
		stall.noteRefusal(STUCK_COPY_OWNER_REFUSED);
		stall.noteClosed();
		stall.noteOpened();
		expect(stall.noteClosed().holdMs).to.equal(0);
	});

	it('clears a held copy after a session that starts no copy, not after one that does', () => {
		const { stall, status } = tracker(2);
		stall.noteCopyStart('k');
		stall.noteClosed();
		stall.noteCopyStart('k');
		stall.noteClosed();
		stall.noteOpened();
		stall.noteCopyStart('k');
		expect(stall.noteSessionQuiet()).to.equal(undefined);
		expect(readStuckCopy(status)).to.include({ state: 'held' });
		stall.noteClosed();
		stall.noteOpened();
		expect(stall.noteSessionQuiet()).to.include({ from: STUCK_COPY_HELD, to: 0, quiet: true });
		expect(readStuckCopy(status)).to.equal(undefined);
		// a copy that starts late in the session still counts from where the attempts were, and its hold
		// keeps doubling
		stall.noteCopyStart('k');
		expect(stall.attempts).to.equal(4);
		expect(stall.noteClosed().holdMs).to.be.at.least(COPY_STALL_HOLD_MIN_MS * 4 - 1);
	});

	it('holds a later copy that fails at one position on a leg an earlier refusal left refused', () => {
		const { stall, status } = tracker(2);
		stall.noteRefusal(STUCK_COPY_ORIGIN_REFUSED);
		stall.noteClosed();
		stall.noteOpened();
		stall.noteCopyStart('k');
		expect(stall.noteClosed().holdMs).to.equal(0);
		stall.noteOpened();
		stall.noteCopyStart('k');
		const closed = stall.noteClosed();
		expect(closed.holdMs).to.be.at.least(COPY_STALL_HOLD_MIN_MS);
		expect(closed.transition).to.include({ from: STUCK_COPY_RETRYING, to: STUCK_COPY_HELD });
		expect(readStuckCopy(status)).to.include({ state: 'held' });
	});

	it('replaces a refusal with what an accepted copy then does, at close', () => {
		const { stall, status } = tracker(5);
		stall.noteRefusal(STUCK_COPY_ORIGIN_REFUSED);
		stall.noteClosed();
		stall.noteOpened();
		expect(stall.noteCopyStart('k')).to.equal(undefined, 'still refused until this session closes');
		expect(stall.noteClosed().transition).to.include({ from: STUCK_COPY_REFUSED, to: 0 });
		for (let i = 0; i < 2; i++) {
			stall.noteOpened();
			stall.noteCopyStart('k');
			stall.noteClosed();
		}
		expect(readStuckCopy(status)).to.include({ state: 'retrying', count: 3 });
	});

	it('reports a refusal whose reason changes', () => {
		const { stall } = tracker();
		expect(stall.noteRefusal(STUCK_COPY_ORIGIN_REFUSED)).to.include({ to: STUCK_COPY_REFUSED });
		expect(stall.noteRefusal(STUCK_COPY_OWNER_REFUSED)).to.include({
			to: STUCK_COPY_REFUSED,
			reason: STUCK_COPY_OWNER_REFUSED,
		});
		expect(stall.noteRefusal(STUCK_COPY_OWNER_REFUSED)).to.equal(undefined);
	});

	it('restarts the hold at its floor after a quiet clear once progress or a new position comes', () => {
		for (const recover of [(stall) => stall.noteDurableProgress(), (stall) => stall.noteCopyStart('elsewhere')]) {
			const { stall } = tracker(2);
			stall.noteRefusal(STUCK_COPY_OWNER_REFUSED);
			stall.noteClosed();
			stall.noteOpened();
			stall.noteSessionQuiet();
			recover(stall);
			stall.noteOpened();
			stall.noteRefusal(STUCK_COPY_OWNER_REFUSED);
			expect(stall.noteClosed().holdMs).to.equal(COPY_STALL_HOLD_MIN_MS);
		}
	});

	it('leaves the shared status untouched for progress on a leg with nothing stuck', () => {
		const { stall, status } = tracker();
		status.fill(7);
		expect(stall.noteDurableProgress()).to.equal(undefined);
		expect([...status].every((slot) => slot === 7)).to.equal(true);
	});

	it('keys a resume cursor by its value, not its object identity', () => {
		const cursor = () => ({ copyStartTime: 5, currentTable: 'T', afterKey: Buffer.from([1, 2]), copyOrder: 3 });
		expect(copyStartKey(cursor(), encode)).to.equal(copyStartKey(cursor(), encode));
		expect(copyStartKey({ ...cursor(), afterKey: Buffer.from([1, 3]) }, encode)).to.not.equal(
			copyStartKey(cursor(), encode)
		);
		expect(copyStartKey(undefined, encode)).to.equal('fresh');
	});
});

describe('unnamedOriginName', () => {
	it('names an origin by the node holding it and its id there', () => {
		expect(unnamedOriginName('node-a.example.com', 19)).to.equal('unnamed-origin-19@node-a.example.com');
	});

	it('recognizes only names derived for this node', () => {
		const name = unnamedOriginName('node-a', 19);
		expect(ownUnnamedOriginId(name, 'node-a')).to.equal(19);
		expect(ownUnnamedOriginId(name, 'node-b')).to.equal(undefined);
		expect(ownUnnamedOriginId('unnamed-origin-0@node-a', 'node-a')).to.equal(undefined);
		expect(ownUnnamedOriginId('node-a', 'node-a')).to.equal(undefined);
	});

	it('escapes what cannot sit in a log name, distinctly', () => {
		const name = unnamedOriginName('fe80::1', 7);
		expect(name).to.match(/^unnamed-origin-7@[A-Za-z0-9._-]+$/);
		expect(unnamedOriginName('a_3a', 7)).to.not.equal(unnamedOriginName('a:', 7));
	});
});
