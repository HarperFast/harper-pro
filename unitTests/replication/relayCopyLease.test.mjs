/**
 * The relay copy lease (harper-pro#1299): an inbound base copy pass holds a slot for its database while it runs, and
 * senders withhold relayed origins while any slot is live.
 */
import assert from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { holdRelayCopyLease, relayCopyLeaseHeld, RELAY_COPY_LEASE_TTL_MS } from '#src/replication/relayCopyLease';

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
		for (const lease of leases) lease.release();
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

	it('lapses when it is not renewed, and a renewal extends it', () => {
		const store = sharedStore();
		const lease = hold(store, 'data');
		now += RELAY_COPY_LEASE_TTL_MS - 1;
		lease.renew();
		now += RELAY_COPY_LEASE_TTL_MS - 1;
		assert.strictEqual(relayCopyLeaseHeld(store, 'data', now), true);
		assert.strictEqual(relayCopyLeaseHeld(store, 'data', now + 1), false);
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
