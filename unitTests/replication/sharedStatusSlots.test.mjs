/** Invariants for the replication shared-status slot registry (`replication/sharedStatusSlots.ts`). */

import { expect } from 'chai';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as slots from '#src/replication/sharedStatusSlots';
import { getReplicationSharedStatus } from '#src/replication/knownNodes';

const REPLICATION_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'replication');
const REGISTRY_RELATIVE_PATH = 'sharedStatusSlots.ts';

/** Every `_POSITION`-suffixed identifier bound by a variable declaration, destructuring element, or
 * class property in a source file. */
function declaredPositionNames(source, fileName) {
	const names = [];
	const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
	const visit = (node) => {
		const binds = ts.isVariableDeclaration(node) || ts.isBindingElement(node) || ts.isPropertyDeclaration(node);
		if (binds && ts.isIdentifier(node.name) && node.name.text.endsWith('_POSITION')) {
			names.push(node.name.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return names;
}

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
		// Occupy the fire-counter block's whole range, not just its named base slot, so a single-slot
		// constant landing anywhere inside it is caught as a collision too.
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

	it('has not exceeded its own declared capacity', () => {
		expect(slots.ALLOCATED_SLOTS).to.be.at.most(slots.REPLICATION_SHARED_STATUS_SLOTS);
	});

	it('assertAllocationFits throws once allocation exceeds capacity, not before', () => {
		// A module-level `if (over) throw` only ever runs in the passing case by the time this file's
		// own import succeeds, so it can't prove the throw fires — call the extracted function directly
		// with a deliberate overflow instead.
		expect(() => slots.assertAllocationFits(65, 64)).to.throw(/allocated 65 slots/);
		expect(() => slots.assertAllocationFits(64, 64)).to.not.throw();
	});

	it('declaredPositionNames also catches destructured and class-property declarations', () => {
		expect(declaredPositionNames('const { NEW_POSITION } = obj;', 'a.ts')).to.deep.equal(['NEW_POSITION']);
		expect(declaredPositionNames('const { foo: NEW_POSITION } = obj;', 'a.ts')).to.deep.equal(['NEW_POSITION']);
		expect(declaredPositionNames('class X { static NEW_POSITION = 40; }', 'a.ts')).to.deep.equal(['NEW_POSITION']);
	});

	it('never hand-numbers a *_POSITION slot constant outside the registry', () => {
		const offenders = [];
		for (const file of readdirSync(REPLICATION_DIR, { withFileTypes: true, recursive: true })) {
			if (!file.isFile() || !file.name.endsWith('.ts')) continue;
			const dir = file.parentPath ?? file.path;
			const relativePath = relative(REPLICATION_DIR, join(dir, file.name));
			if (relativePath === REGISTRY_RELATIVE_PATH) continue;
			const source = readFileSync(join(dir, file.name), 'utf8');
			for (const name of declaredPositionNames(source, file.name)) offenders.push(`${relativePath}: ${name}`);
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
