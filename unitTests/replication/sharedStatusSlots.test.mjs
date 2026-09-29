/**
 * Invariants for the replication shared-status slot registry (harper-pro#885). Positions used to be
 * hand-numbered independently in `replicationConnection.ts` and `recordLockTransport.ts`, with only
 * `knownNodes.ts` owning the buffer size — nothing caught two modules picking the same offset except a
 * human reading three files. `sharedStatusSlots.ts` is now the single allocation point; this pins that
 * every slot it hands out is distinct and in range, that the fire-counter block does not encroach on its
 * neighbors, and that no other file in `replication/` hand-numbers a `*_POSITION` slot constant outside
 * the registry (the collision the registry exists to prevent by construction, but only for callers that
 * actually go through it).
 */

import { expect } from 'chai';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as slots from '#src/replication/sharedStatusSlots';
import { getReplicationSharedStatus } from '#src/replication/knownNodes';

const REPLICATION_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'replication');
const REGISTRY_FILE = 'sharedStatusSlots.ts';
// Matches a hand-numbered slot declaration, e.g. `const FOO_POSITION = 29;` — deliberately not
// `= allocate(...)`, which is only valid inside the registry itself. Not anchored to `export`: a
// declaration re-exported separately (`const FOO_POSITION = 29; export { FOO_POSITION };`) is the
// same hand-numbering this guards against.
const HAND_NUMBERED_POSITION = /\bconst\s+(\w+_POSITION)\s*=\s*-?\d+\b/g;

/** Enough of an audit store for `getReplicationSharedStatus`: one stable buffer per (db, peer) key. */
function fakeAuditStore() {
	const buffers = new Map();
	return {
		getUserSharedBuffer(key, initial) {
			const id = JSON.stringify(key);
			let buffer = buffers.get(id);
			if (!buffer) buffers.set(id, (buffer = initial));
			return buffer;
		},
	};
}

describe('replication shared-status slot registry', () => {
	const positionEntries = Object.entries(slots).filter(([name]) => name.endsWith('_POSITION'));

	it('assigns every *_POSITION export a distinct, in-range slot, reserving the fire-counter block whole', () => {
		expect(positionEntries.length).to.be.greaterThan(0);
		// FIRE_COUNTER_BASE_POSITION names only the block's first slot; occupy the whole block up
		// front so a single-slot constant landing anywhere inside 13..28 is caught as a collision,
		// not just one landing exactly on slot 13.
		const occupied = new Map();
		const blockStart = slots.FIRE_COUNTER_BASE_POSITION;
		const blockLength = slots.FIRE_MECHANISMS.length * 2;
		for (let slot = blockStart; slot < blockStart + blockLength; slot++) occupied.set(slot, 'fire-counter block');

		for (const [name, value] of positionEntries) {
			if (name === 'FIRE_COUNTER_BASE_POSITION') continue;
			expect(Number.isInteger(value), `${name} must be an integer slot, got ${value}`).to.equal(true);
			expect(value, `${name}=${value} is out of range`).to.be.within(0, slots.REPLICATION_SHARED_STATUS_SLOTS - 1);
			expect(occupied.has(value), `${name} collides with ${occupied.get(value)} at slot ${value}`).to.equal(false);
			occupied.set(value, name);
		}
	});

	it('reserves the fire-counter block without overlapping its neighbors', () => {
		const blockStart = slots.FIRE_COUNTER_BASE_POSITION;
		const blockEnd = blockStart + slots.FIRE_MECHANISMS.length * 2; // exclusive
		expect(blockStart, 'fire block must start after the core link-status slots').to.be.greaterThan(
			slots.LAST_ERROR_TIME_POSITION
		);
		expect(blockEnd, 'fire block must not reach the record-lock slots').to.be.at.most(
			slots.RECORD_LOCKS_CAPABILITY_POSITION
		);
	});

	it('never allocates more slots than REPLICATION_SHARED_STATUS_SLOTS holds', () => {
		// A block allocation (like the fire-counter one above) can push the true end past the size
		// while its own base position still reads "in range" on its own — this pins the aggregate,
		// belt-and-suspenders alongside the registry's own load-time throw for the same condition.
		expect(slots.ALLOCATED_SLOTS).to.be.at.most(slots.REPLICATION_SHARED_STATUS_SLOTS);
	});

	it('never hand-numbers a *_POSITION slot constant outside the registry', () => {
		const offenders = [];
		for (const file of readdirSync(REPLICATION_DIR, { withFileTypes: true })) {
			if (!file.isFile() || !file.name.endsWith('.ts') || file.name === REGISTRY_FILE) continue;
			const source = readFileSync(join(REPLICATION_DIR, file.name), 'utf8');
			HAND_NUMBERED_POSITION.lastIndex = 0;
			let match;
			while ((match = HAND_NUMBERED_POSITION.exec(source))) offenders.push(`${file.name}: ${match[1]}`);
		}
		expect(offenders, 'add new slots to sharedStatusSlots.ts instead of hand-numbering them').to.deep.equal([]);
	});

	it('getReplicationSharedStatus() returns a buffer that addresses the new top slot', () => {
		const auditStore = fakeAuditStore();
		const topSlot = slots.REPLICATION_SHARED_STATUS_SLOTS - 1;
		getReplicationSharedStatus(auditStore, 'data', 'peer')[topSlot] = 42;
		expect(getReplicationSharedStatus(auditStore, 'data', 'peer')[topSlot]).to.equal(42);
	});
});
