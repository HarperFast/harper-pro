import { expect } from 'chai';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as slots from '#src/replication/sharedStatusSlots';
import { getReplicationSharedStatus } from '#src/replication/knownNodes';

const REPLICATION_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'replication');
const REGISTRY_RELATIVE_PATH = 'sharedStatusSlots.ts';
const SLOT_NAME_SUFFIXES = ['_POSITION', '_SLOT', '_INDEX'];

function isLiteralName(node) {
	if (node && ts.isParenthesizedExpression(node)) return isLiteralName(node.expression);
	return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
}

function literalNameText(node) {
	return ts.isParenthesizedExpression(node) ? literalNameText(node.expression) : node.text;
}

function staticName(node) {
	if (!node) return undefined;
	if (ts.isIdentifier(node) || isLiteralName(node)) return node.text;
	// Inside a computed key an identifier REFERENCES a constant rather than binding a name, so
	// `{ [RECEIVED_VERSION_POSITION]: 'received' }` is a legitimate use of the registry, not a slot.
	if (ts.isComputedPropertyName(node) && isLiteralName(node.expression)) return literalNameText(node.expression);
	return undefined;
}

function declaredPositionNames(source, fileName) {
	const names = [];
	const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
	const visit = (node) => {
		const binds =
			ts.isVariableDeclaration(node) ||
			ts.isBindingElement(node) ||
			ts.isPropertyDeclaration(node) ||
			ts.isPropertyAssignment(node) ||
			ts.isEnumMember(node);
		const name = binds ? staticName(node.name) : undefined;
		if (name && SLOT_NAME_SUFFIXES.some((s) => name.endsWith(s))) {
			names.push(name);
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return names;
}

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
	const positionEntries = Object.entries(slots).filter(([name]) => SLOT_NAME_SUFFIXES.some((x) => name.endsWith(x)));

	it('assigns every slot export a distinct, in-range slot, reserving the fire-counter block whole', () => {
		expect(positionEntries.length).to.be.greaterThan(0);
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
		const blockEnd = blockStart + slots.FIRE_MECHANISMS.length * 2;
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
		expect(() => slots.assertAllocationFits(65, 64)).to.throw(/allocated 65 slots/);
		expect(() => slots.assertAllocationFits(64, 64)).to.not.throw();
	});

	it('declaredPositionNames also catches destructured and class-property declarations', () => {
		expect(declaredPositionNames('const { NEW_POSITION } = obj;', 'a.ts')).to.deep.equal(['NEW_POSITION']);
		expect(declaredPositionNames('const { foo: NEW_POSITION } = obj;', 'a.ts')).to.deep.equal(['NEW_POSITION']);
		expect(declaredPositionNames('class X { static NEW_POSITION = 40; }', 'a.ts')).to.deep.equal(['NEW_POSITION']);
	});

	it('declaredPositionNames catches the _SLOT and _INDEX spellings too', () => {
		expect(declaredPositionNames('const NEW_SLOT = 40;', 'a.ts')).to.deep.equal(['NEW_SLOT']);
		expect(declaredPositionNames('const NEW_INDEX = 40;', 'a.ts')).to.deep.equal(['NEW_INDEX']);
		expect(declaredPositionNames('const UNRELATED_OFFSET = 40;', 'a.ts')).to.deep.equal([]);
	});

	it('declaredPositionNames catches an object-literal slot however the key is spelled', () => {
		expect(declaredPositionNames('const o = { PEER_POSITION: 30 };', 'a.ts')).to.deep.equal(['PEER_POSITION']);
		expect(declaredPositionNames("const o = { 'PEER_POSITION': 30 };", 'a.ts')).to.deep.equal(['PEER_POSITION']);
		expect(declaredPositionNames("const o = { ['PEER_SLOT']: 30 };", 'a.ts')).to.deep.equal(['PEER_SLOT']);
		expect(declaredPositionNames('const o = { [`PEER_INDEX`]: 30 };', 'a.ts')).to.deep.equal(['PEER_INDEX']);
		expect(declaredPositionNames("const o = { [('PEER_SLOT')]: 30 };", 'a.ts')).to.deep.equal(['PEER_SLOT']);
		expect(declaredPositionNames('const o = { [dynamic]: 30 };', 'a.ts')).to.deep.equal([]);
	});

	it('declaredPositionNames catches an enum member slot too', () => {
		expect(declaredPositionNames('enum E { PEER_POSITION = 30 }', 'a.ts')).to.deep.equal(['PEER_POSITION']);
		expect(declaredPositionNames("enum E { 'PEER_SLOT' = 30 }", 'a.ts')).to.deep.equal(['PEER_SLOT']);
	});

	it("declaredPositionNames leaves a map keyed by the registry's own constants alone", () => {
		expect(declaredPositionNames("const labels = { [PEER_SLOT]: 'peer' };", 'a.ts')).to.deep.equal([]);
		expect(declaredPositionNames("const labels = { [RECEIVED_VERSION_POSITION]: 'v' };", 'a.ts')).to.deep.equal([]);
	});

	it('never hand-numbers a slot constant outside the registry, under any of its spellings', () => {
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

	it('getReplicationSharedStatus() always requests the registry capacity, never a caller-chosen size', () => {
		const sizes = [];
		const auditStore = {
			buffers: new Map(),
			getUserSharedBuffer(key, defaultBuffer) {
				sizes.push(defaultBuffer.byteLength);
				const id = key.join('/');
				if (!this.buffers.has(id)) this.buffers.set(id, defaultBuffer);
				return this.buffers.get(id);
			},
		};
		getReplicationSharedStatus(auditStore, 'data', 'peer');
		getReplicationSharedStatus(auditStore, 'data', 'peer');
		getReplicationSharedStatus(auditStore, 'other', 'peer');
		expect(new Set(sizes)).to.deep.equal(new Set([slots.REPLICATION_SHARED_STATUS_SLOTS * 8]));
	});
});
