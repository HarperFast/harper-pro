import assert from 'node:assert';
import { table } from '#src/core/resources/databases';
import {
	advanceShardingHistory,
	readShardingHistory,
	readShardingBaseline,
	validateShardingFloors,
	inheritShardingHistory,
} from '#src/replication/shardingBootstrapState';

describe('Durable sharding startup evidence', () => {
	let catalog;
	before(() => {
		catalog = table({
			database: 'bootstrapEvidence',
			table: 'Rows',
			primaryKey: 'id',
			attributes: [{ name: 'id' }],
		}).dbisDB;
	});
	it('requires a valid origin floor from exactly the agreed members', () => {
		const members = ['a', 'b'];
		validateShardingFloors({ a: 100, b: 101 }, members);
		for (const value of [
			{ a: 100 },
			{ a: 100, b: 0 },
			{ a: Infinity, b: 101 },
			{ a: 100, b: '101' },
			{ a: 100, b: 101, c: 102 },
		])
			assert.throws(() => validateShardingFloors(value, members), /every agreed member/);
	});
	it('keeps a ready witness separate from permission to originate writes', () => {
		const state = {
			initializer: 'a',
			run: 'run-a',
			scope: 'native-root-conversions',
			agreement: 'members-and-map',
			phase: 'began',
		};
		advanceShardingHistory(catalog, 'phases', state);
		assert.throws(
			() => advanceShardingHistory(catalog, 'phases', { ...state, phase: 'active', floors: { a: 100 } }),
			/ready witness/
		);
		advanceShardingHistory(catalog, 'phases', { ...state, phase: 'witnessed', floors: { a: 100 } }, true);
		assert.equal(readShardingHistory(catalog, 'phases').phase, 'witnessed');
		assert.deepEqual(readShardingBaseline(catalog, 'phases').floors, { a: 100 });
		advanceShardingHistory(catalog, 'phases', { ...state, phase: 'active', floors: { a: 100 } });
		advanceShardingHistory(catalog, 'phases', state);
		assert.equal(readShardingHistory(catalog, 'phases').phase, 'active', 'late messages cannot restore freshness');
		assert.throws(
			() => advanceShardingHistory(catalog, 'phases', { ...state, agreement: 'different-members' }),
			/membership changed/
		);
		assert.throws(
			() => advanceShardingHistory(catalog, 'phases', { ...state, phase: 'active', floors: { a: 200 } }),
			/baseline changed/
		);
	});
	it('can re-elect an unwitnessed attempt but never converts inherited history into an empty baseline', () => {
		const state = {
			initializer: 'a',
			run: 'run-a',
			scope: 'native-root-conversions',
			agreement: 'old-members',
			phase: 'began',
		};
		advanceShardingHistory(catalog, 're-election', state);
		const replacement = { ...state, initializer: 'b', run: 'run-b', agreement: 'new-members' };
		assert.throws(() => advanceShardingHistory(catalog, 're-election', replacement), /run changed/);
		advanceShardingHistory(catalog, 're-election', replacement, false, state.run);
		assert.throws(() => advanceShardingHistory(catalog, 're-election', state), /run changed/);
		assert.throws(
			() => advanceShardingHistory(catalog, 're-election', { ...state, phase: 'witnessed', floors: { a: 100 } }),
			/run changed/
		);
		assert.equal(readShardingHistory(catalog, 're-election').initializer, 'b');
		const witnessed = { ...replacement, phase: 'witnessed', floors: { b: 100, c: 101 } };
		advanceShardingHistory(catalog, 're-election', witnessed);
		assert.throws(() => advanceShardingHistory(catalog, 're-election', state), /run changed/);
		assert.throws(() => advanceShardingHistory(catalog, 're-election', witnessed, true), /empty replacement root/);
		assert.equal(readShardingBaseline(catalog, 're-election'), undefined);
		advanceShardingHistory(catalog, 're-election', { ...witnessed, phase: 'active', floors: { c: 101, b: 100 } });
		assert.equal(readShardingHistory(catalog, 're-election').phase, 'active');
	});

	it('never records an initial baseline before the ready witness', () => {
		assert.throws(
			() =>
				advanceShardingHistory(
					catalog,
					'premature',
					{ initializer: 'a', run: 'run-a', scope: 'native-root-conversions', agreement: 'a', phase: 'began' },
					true
				),
			/ready witness/
		);
		assert.equal(readShardingHistory(catalog, 'premature'), undefined);
		assert.equal(readShardingBaseline(catalog, 'premature'), undefined);
	});
	it('a late root inherits established history without inheriting an empty baseline', () => {
		const active = {
			initializer: 'a',
			run: 'old-run',
			agreement: 'old-members',
			phase: 'active',
			floors: { a: 100 },
			scope: 'source-root',
			localFloor: 100,
			localOrigin: 'a',
		};
		inheritShardingHistory(catalog, 'late-root', active);
		assert.equal(readShardingHistory(catalog, 'late-root').phase, 'active');
		assert.equal(readShardingHistory(catalog, 'late-root').scope, undefined);
		assert.equal(readShardingHistory(catalog, 'late-root').localFloor, undefined);
		assert.equal(readShardingHistory(catalog, 'late-root').localOrigin, undefined);
		assert.equal(readShardingBaseline(catalog, 'late-root'), undefined);
		assert.throws(
			() => advanceShardingHistory(catalog, 'late-root', { ...active, phase: 'witnessed' }, true),
			/empty replacement root/
		);
		assert.throws(
			() =>
				advanceShardingHistory(catalog, 'late-root', { ...active, run: 'new-run', phase: 'began' }, false, 'old-run'),
			/run changed/
		);
	});
	it('keeps its own durable witness when another member activates the same run first', () => {
		const local = {
			initializer: 'a',
			run: 'activation-race',
			agreement: 'same-members',
			phase: 'began',
			localFloor: 101,
			localOrigin: 'b',
			scope: 'local-root',
		};
		advanceShardingHistory(catalog, 'activation-race', local);
		const witnessed = { ...local, phase: 'witnessed', floors: { a: 100, b: 101 } };
		advanceShardingHistory(catalog, 'activation-race', witnessed, true);
		const peer = { ...witnessed, phase: 'active', localFloor: 100, localOrigin: 'a', scope: 'peer-root' };
		for (const changed of [
			{ run: 'another-run' },
			{ agreement: 'another-membership' },
			{ initializer: 'b' },
			{ floors: { a: 100, b: 102 } },
		]) {
			assert.throws(
				() => inheritShardingHistory(catalog, 'activation-race', { ...peer, ...changed }),
				/Conflicting witnessed/
			);
			assert.deepEqual({ ...readShardingHistory(catalog, 'activation-race') }, witnessed);
		}
		inheritShardingHistory(catalog, 'activation-race', peer);
		assert.deepEqual({ ...readShardingHistory(catalog, 'activation-race') }, { ...witnessed, phase: 'active' });
		assert.deepEqual({ ...readShardingBaseline(catalog, 'activation-race') }, witnessed);
	});

	it('aborts the witness and baseline together if either write fails', () => {
		const state = {
			initializer: 'a',
			run: 'run-a',
			scope: 'native-root-conversions',
			agreement: 'crash-members',
			phase: 'began',
		};
		advanceShardingHistory(catalog, 'crash', state);
		const transactionSync = catalog.transactionSync;
		catalog.transactionSync = function (callback, options) {
			return transactionSync.call(
				this,
				(transaction) => {
					const putSync = transaction.putSync.bind(transaction);
					let writes = 0;
					transaction.putSync = (...args) => {
						putSync(...args);
						if (++writes === 2) throw new Error('injected crash before commit');
					};
					return callback(transaction);
				},
				options
			);
		};
		try {
			assert.throws(
				() => advanceShardingHistory(catalog, 'crash', { ...state, phase: 'witnessed', floors: { a: 100 } }, true),
				/injected crash/
			);
		} finally {
			catalog.transactionSync = transactionSync;
		}
		assert.deepEqual({ ...readShardingHistory(catalog, 'crash') }, state);
		assert.equal(readShardingBaseline(catalog, 'crash'), undefined);
	});
});
