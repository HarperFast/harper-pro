/**
 * The relay copy lease (harper-pro#1299): an inbound base copy pass holds a slot for its database while it runs, and
 * senders withhold relayed origins while any slot is live.
 */
import assert from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import {
	holdRelayCopyLease,
	newPassToken,
	passCreatedAt,
	relayCopyLeaseClaims,
	relayCopyLeaseHeld,
	reservationHolds,
	RELAY_COPY_LEASE_TTL_MS,
	RESERVATION_HOLD_MS,
	RESERVATION_MAX_AGE_MS,
} from '#src/replication/relayCopyLease';

const T = 1_790_000_000_000;

/** Stands in for a store's `getUserSharedBuffer`: one buffer per key, shared by every caller. */
function sharedStore() {
	const buffers = new Map();
	return {
		getUserSharedBuffer(key, initial) {
			const name = JSON.stringify(key);
			if (!buffers.has(name)) buffers.set(name, new SharedArrayBuffer(initial.byteLength));
			return buffers.get(name);
		},
	};
}

describe('relay copy lease', () => {
	let leases;
	let now;
	const clock = () => now;
	const hold = (store, database, running = () => true, options = {}) => {
		const lease = holdRelayCopyLease(store, database, running, { clock, ...options });
		if (lease) leases.push(lease);
		return lease;
	};
	beforeEach(() => {
		leases = [];
		now = T;
	});
	afterEach(() => {
		leases?.forEach((lease) => lease.release());
	});

	it('is held from the claim until the release, for its own database only', () => {
		const store = sharedStore();
		assert.strictEqual(relayCopyLeaseHeld(store, 'data', now), false);
		const lease = hold(store, 'data');
		assert.ok(lease);
		assert.strictEqual(relayCopyLeaseHeld(store, 'data', now), true);
		assert.strictEqual(relayCopyLeaseHeld(store, 'other', now), false);
		lease.release();
		assert.strictEqual(relayCopyLeaseHeld(store, 'data', now), false);
	});

	it('counts every claim, so a pass that came and went is still visible', () => {
		const store = sharedStore();
		const before = relayCopyLeaseClaims(store, 'data');
		hold(store, 'data').release();
		assert.strictEqual(relayCopyLeaseHeld(store, 'data', now), false);
		assert.strictEqual(relayCopyLeaseClaims(store, 'data'), before + 1n);
	});

	it('lapses when it is not renewed, and a renewal extends it', () => {
		const store = sharedStore();
		const lease = hold(store, 'data');
		now += RELAY_COPY_LEASE_TTL_MS - 1;
		lease.renew();
		now += RELAY_COPY_LEASE_TTL_MS - 1;
		assert.strictEqual(relayCopyLeaseHeld(store, 'data', now), true);
		assert.strictEqual(relayCopyLeaseHeld(store, 'data', now + 1), false);
	});

	it('counts a renewal after its slot lapsed as a new claim', () => {
		const store = sharedStore();
		const lease = hold(store, 'data');
		const claims = relayCopyLeaseClaims(store, 'data');
		now += RELAY_COPY_LEASE_TTL_MS - 1;
		lease.renew();
		assert.strictEqual(relayCopyLeaseClaims(store, 'data'), claims);
		now += RELAY_COPY_LEASE_TTL_MS + 1;
		assert.strictEqual(relayCopyLeaseHeld(store, 'data', now), false);
		lease.renew();
		assert.strictEqual(relayCopyLeaseHeld(store, 'data', now), true);
		assert.strictEqual(relayCopyLeaseClaims(store, 'data'), claims + 1n);
	});

	it('releases on the renewal after its pass stopped, and never claims again', () => {
		const store = sharedStore();
		let running = true;
		const lease = hold(store, 'data', () => running);
		running = false;
		lease.renew();
		assert.strictEqual(relayCopyLeaseHeld(store, 'data', now), false);
		running = true;
		lease.renew();
		assert.strictEqual(relayCopyLeaseHeld(store, 'data', now), false);
	});

	it("keeps another pass's slot when one releases, and claims a lapsed slot once taken", () => {
		const store = sharedStore();
		const first = hold(store, 'data');
		const second = hold(store, 'data');
		first.release();
		assert.strictEqual(relayCopyLeaseHeld(store, 'data', now), true);
		second.release();
		assert.strictEqual(relayCopyLeaseHeld(store, 'data', now), false);
		// a pass whose renewals stalled past the TTL finds its slot taken and claims another
		const stalled = hold(store, 'data');
		now += RELAY_COPY_LEASE_TTL_MS + 1;
		const taker = hold(store, 'data');
		stalled.renew();
		taker.release();
		assert.strictEqual(relayCopyLeaseHeld(store, 'data', now), true);
		stalled.release();
		assert.strictEqual(relayCopyLeaseHeld(store, 'data', now), false);
	});

	it('reports a stalled pass whose lapsed slot was taken when no other is free', () => {
		const store = sharedStore();
		let lost = 0;
		const stalled = hold(store, 'data', () => true, { onLost: () => lost++ });
		now += RELAY_COPY_LEASE_TTL_MS + 1;
		for (let i = 0; i < 8; i++) assert.ok(hold(store, 'data'));
		stalled.renew();
		assert.strictEqual(lost, 1);
		for (const lease of leases.slice(1)) lease.release();
		assert.strictEqual(relayCopyLeaseHeld(store, 'data', now), false);
	});

	it('refuses a claim when every slot is live, and lets one in once a slot lapses', () => {
		const store = sharedStore();
		for (let i = 0; i < 8; i++) assert.ok(hold(store, 'data'));
		assert.strictEqual(hold(store, 'data'), undefined);
		now += RELAY_COPY_LEASE_TTL_MS + 1;
		assert.ok(hold(store, 'data'));
	});

	it('releases at the settle deadline unless the pass settles or restarts first', async () => {
		const store = sharedStore();
		let expired = 0;
		const lease = hold(store, 'data', () => true, { settleDeadlineMs: 20 });
		lease.armSettleDeadline(() => expired++);
		lease.disarmSettleDeadline();
		await delay(40);
		assert.strictEqual(expired, 0);
		assert.strictEqual(relayCopyLeaseHeld(store, 'data', now), true);
		lease.armSettleDeadline(() => expired++);
		await delay(40);
		assert.strictEqual(expired, 1);
		assert.strictEqual(relayCopyLeaseHeld(store, 'data', now), false);
	});
});

describe('unsettled copy reservation hold', () => {
	const pass = (started) => `${started}:id`;

	it('holds from first sight until the timeout, then releases once with an error', () => {
		const expired = [];
		const p = pass(T);
		assert.strictEqual(
			reservationHolds('hold-a', [p], (x) => expired.push(x), T + 1000),
			true
		);
		assert.strictEqual(
			reservationHolds('hold-a', [p], (x) => expired.push(x), T + 1000 + RESERVATION_HOLD_MS - 1),
			true
		);
		assert.strictEqual(
			reservationHolds('hold-a', [p], (x) => expired.push(x), T + 1000 + RESERVATION_HOLD_MS),
			false
		);
		assert.strictEqual(
			reservationHolds('hold-a', [p], (x) => expired.push(x), T + 2000 + RESERVATION_HOLD_MS),
			false
		);
		assert.deepStrictEqual(expired, [p]);
	});

	it('ignores a reservation created past the maximum age, or with no readable time', () => {
		const expired = [];
		const now = T + RESERVATION_MAX_AGE_MS + 1;
		assert.strictEqual(
			reservationHolds('hold-b', [pass(T), newPassToken(T + 5, T), '0', 'x:id'], (x) => expired.push(x), now),
			false
		);
		assert.deepStrictEqual(expired, []);
	});

	it("ages a reservation from this node's creation time, not the source's copy start", () => {
		// a source with no writes for days anchors its copy at its last log key
		const token = newPassToken(T - 3 * RESERVATION_MAX_AGE_MS, T);
		assert.strictEqual(passCreatedAt(token), T);
		assert.strictEqual(passCreatedAt(pass(T - 5)), T - 5);
		assert.strictEqual(
			reservationHolds('hold-d', [token], () => {}, T + 1000),
			true
		);
	});

	it('forgets a released reservation, so one that comes back is held again', () => {
		const p = pass(T);
		reservationHolds('hold-c', [p], () => {}, T);
		assert.strictEqual(
			reservationHolds('hold-c', [p], () => {}, T + RESERVATION_HOLD_MS),
			false
		);
		assert.strictEqual(
			reservationHolds('hold-c', [], () => {}, T + RESERVATION_HOLD_MS + 1),
			false
		);
		assert.strictEqual(
			reservationHolds('hold-c', [p], () => {}, T + RESERVATION_HOLD_MS + 2),
			true
		);
	});
});
