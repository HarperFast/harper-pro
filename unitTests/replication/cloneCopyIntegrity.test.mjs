import assert from 'node:assert';
import {
	beginCloneCopyIntegrityPass,
	cloneIncompleteStatus,
	finishCloneCopyMetadata,
	recordCloneCopyDrop,
} from '#src/replication/cloneCopyIntegrity';

const symbolName = (value) => (typeof value === 'symbol' ? Symbol.keyFor(value) : value);
const encodedKey = (key) => JSON.stringify(key.map(symbolName));

function memoryStore() {
	const rows = new Map();
	const operations = [];
	const store = {
		rows,
		operations,
		getSync(key) {
			return rows.get(encodedKey(key));
		},
		put(key, value) {
			operations.push(['put', symbolName(key[0])]);
			rows.set(encodedKey(key), structuredClone(value));
		},
		putSync(key, value) {
			operations.push(['putSync', symbolName(key[0])]);
			rows.set(encodedKey(key), structuredClone(value));
		},
		removeSync(key) {
			operations.push(['removeSync', symbolName(key[0])]);
			rows.delete(encodedKey(key));
		},
		transactionSync(callback) {
			operations.push(['transactionSync']);
			const snapshot = new Map([...rows].map(([key, value]) => [key, structuredClone(value)]));
			try {
				return callback({
					getSync: (key) => store.getSync(key),
					put: (key, value) => store.put(key, value),
					putSync: (key, value) => store.putSync(key, value),
					removeSync: (key) => store.removeSync(key),
				});
			} catch (error) {
				rows.clear();
				for (const [key, value] of snapshot) rows.set(key, value);
				throw error;
			}
		},
	};
	return store;
}

describe('clone copy integrity', () => {
	it('records and finalizes an incomplete copy', async () => {
		const store = memoryStore();
		assert.deepStrictEqual(beginCloneCopyIntegrityPass(store, 'leader', 100, 1), { dropCount: 0 });
		await recordCloneCopyDrop(store, 'leader', 100, 'widgets', 'undecodable record', 2);
		assert.strictEqual(cloneIncompleteStatus(store, 'leader').state, 'pending');

		finishCloneCopyMetadata(store, 'leader', 7, 100, 3, 'attempt-1', 3);
		assert.deepStrictEqual(cloneIncompleteStatus(store, 'leader'), {
			state: 'incomplete',
			table: 'widgets',
			reason: 'undecodable record',
			detectedAt: 2,
			count: 3,
			copyStartTime: 100,
			finalizedAt: 3,
			repairAnchor: undefined,
		});
	});

	it('persists every observed drop before finalization', async () => {
		const store = memoryStore();
		await recordCloneCopyDrop(store, 'leader', 100, 'widgets', 'first drop', 2);
		await recordCloneCopyDrop(store, 'leader', 100, 'widgets', 'second drop', 3);

		assert.deepStrictEqual(beginCloneCopyIntegrityPass(store, 'leader', 100, 4), { dropCount: 2 });
		assert.equal(cloneIncompleteStatus(store, 'leader').count, 2);
	});

	it('inherits a drop when the same copy anchor resumes', async () => {
		const store = memoryStore();
		await recordCloneCopyDrop(store, 'leader', 100, 'widgets', 'undecodable record', 2);
		finishCloneCopyMetadata(store, 'leader', 7, 100, 1, 'attempt-1', 3);

		assert.deepStrictEqual(beginCloneCopyIntegrityPass(store, 'leader', 100, 4), { dropCount: 1 });
		assert.strictEqual(cloneIncompleteStatus(store, 'leader').state, 'incomplete');
	});

	it('keeps the old evidence while a different-anchor repair runs, then clears it', async () => {
		const store = memoryStore();
		await recordCloneCopyDrop(store, 'leader', 100, 'widgets', 'undecodable record', 2);
		finishCloneCopyMetadata(store, 'leader', 7, 100, 1, 'attempt-1', 3);

		assert.deepStrictEqual(beginCloneCopyIntegrityPass(store, 'leader', 200, 4), { dropCount: 0 });
		assert.deepStrictEqual(cloneIncompleteStatus(store, 'leader'), {
			state: 'repairing',
			table: 'widgets',
			reason: 'undecodable record',
			detectedAt: 2,
			count: 1,
			copyStartTime: 100,
			finalizedAt: 3,
			repairAnchor: 200,
		});

		finishCloneCopyMetadata(store, 'leader', 7, 200, 0, 'attempt-2', 5);
		assert.strictEqual(cloneIncompleteStatus(store, 'leader'), undefined);
	});

	it('keeps a terminal incomplete verdict visible when a repair also drops a row', async () => {
		const store = memoryStore();
		await recordCloneCopyDrop(store, 'leader', 100, 'widgets', 'first copy drop', 2);
		finishCloneCopyMetadata(store, 'leader', 7, 100, 1, 'attempt-1', 3);
		beginCloneCopyIntegrityPass(store, 'leader', 200, 4);

		await recordCloneCopyDrop(store, 'leader', 200, 'widgets', 'repair drop', 5);
		assert.deepStrictEqual(cloneIncompleteStatus(store, 'leader'), {
			state: 'incomplete',
			table: 'widgets',
			reason: 'repair drop',
			detectedAt: 5,
			count: 1,
			copyStartTime: 200,
			finalizedAt: 3,
			repairAnchor: undefined,
		});

		finishCloneCopyMetadata(store, 'leader', 7, 200, 1, 'attempt-2', 6);
		assert.equal(cloneIncompleteStatus(store, 'leader').finalizedAt, 6);
	});

	it('finalizes a same-anchor marker even when the in-memory count was lost', async () => {
		const store = memoryStore();
		await recordCloneCopyDrop(store, 'leader', 100, 'widgets', 'undecodable record', 2);

		finishCloneCopyMetadata(store, 'leader', 7, 100, 0, 'attempt-1', 3);
		assert.strictEqual(cloneIncompleteStatus(store, 'leader').state, 'incomplete');
	});

	it('does not let a clean copy from another source clear the leader marker', async () => {
		const store = memoryStore();
		await recordCloneCopyDrop(store, 'leader', 100, 'widgets', 'undecodable record', 2);
		finishCloneCopyMetadata(store, 'leader', 7, 100, 1, 'attempt-1', 3);

		beginCloneCopyIntegrityPass(store, 'other', 200, 4);
		finishCloneCopyMetadata(store, 'other', 8, 200, 0, undefined, 5);
		assert.strictEqual(cloneIncompleteStatus(store, 'leader').state, 'incomplete');
		assert.strictEqual(cloneIncompleteStatus(store, 'other'), undefined);
	});

	it('orders integrity disposition before copy completion and cursor removal', async () => {
		const store = memoryStore();
		await recordCloneCopyDrop(store, 'leader', 100, 'widgets', 'undecodable record', 2);
		store.operations.length = 0;

		finishCloneCopyMetadata(store, 'leader', 7, 100, 1, 'attempt-1', 3);
		assert.deepStrictEqual(store.operations, [
			['transactionSync'],
			['putSync', 'cloneCopyDrop'],
			['putSync', 'cloneCopyComplete'],
			['removeSync', 'copyCursor'],
		]);
	});

	it('finalizes the source-named verdict when no numeric source id exists', async () => {
		const store = memoryStore();
		await recordCloneCopyDrop(store, 'leader', 100, 'widgets', 'undecodable record', 2);

		finishCloneCopyMetadata(store, 'leader', undefined, 100, 1, 'attempt-1', 3);
		assert.strictEqual(cloneIncompleteStatus(store, 'leader').state, 'incomplete');
		assert.equal(
			store.operations.some((operation) => operation[1] === 'cloneCopyComplete'),
			false
		);
	});

	it('uses the engine transaction handle for every final metadata operation', () => {
		const rows = new Map([
			[
				encodedKey([Symbol.for('cloneCopyDrop'), 'leader']),
				{
					copyStartTime: 100,
					table: 'widgets',
					reason: 'undecodable record',
					detectedAt: 2,
					count: 1,
				},
			],
			[encodedKey([Symbol.for('copyCursor'), 7]), { copyStartTime: 100, afterKey: 'row-9' }],
		]);
		const baseOperation = () => assert.fail('metadata operation escaped the transaction handle');
		const store = {
			getSync: baseOperation,
			put: baseOperation,
			putSync: baseOperation,
			removeSync: baseOperation,
			transactionSync(callback) {
				return callback({
					getSync: (key) => rows.get(encodedKey(key)),
					putSync: (key, value) => rows.set(encodedKey(key), structuredClone(value)),
					removeSync: (key) => rows.delete(encodedKey(key)),
				});
			},
		};

		finishCloneCopyMetadata(store, 'leader', 7, 100, 1, 'attempt-1', 3);
		assert.equal(rows.get(encodedKey([Symbol.for('cloneCopyDrop'), 'leader'])).finalizedAt, 3);
		assert.deepStrictEqual(rows.get(encodedKey([Symbol.for('cloneCopyComplete'), 7])), {
			cloneAttempt: 'attempt-1',
			copyStartTime: 100,
		});
		assert.equal(rows.has(encodedKey([Symbol.for('copyCursor'), 7])), false);
	});

	it('keeps repair evidence and the resume cursor when final metadata cannot commit', async () => {
		const store = memoryStore();
		await recordCloneCopyDrop(store, 'leader', 100, 'widgets', 'undecodable record', 2);
		finishCloneCopyMetadata(store, 'leader', 7, 100, 1, 'attempt-1', 3);
		beginCloneCopyIntegrityPass(store, 'leader', 200, 4);
		store.putSync([Symbol.for('copyCursor'), 7], { copyStartTime: 200, afterKey: 'row-9' });
		const putSync = store.putSync;
		store.putSync = (key, value) => {
			if (key[0] === Symbol.for('cloneCopyComplete')) throw new Error('disk full');
			return putSync(key, value);
		};

		assert.throws(() => finishCloneCopyMetadata(store, 'leader', 7, 200, 0, 'attempt-2', 5), /disk full/);
		assert.strictEqual(cloneIncompleteStatus(store, 'leader').state, 'repairing');
		assert.deepStrictEqual(store.getSync([Symbol.for('copyCursor'), 7]), {
			copyStartTime: 200,
			afterKey: 'row-9',
		});
	});

	it('surfaces malformed and unreadable markers as unknown', () => {
		const malformed = memoryStore();
		malformed.rows.set(encodedKey([Symbol.for('cloneCopyDrop'), 'leader']), { count: 1 });
		assert.deepStrictEqual(cloneIncompleteStatus(malformed, 'leader'), {
			state: 'unknown',
			reason: 'invalid-marker',
		});

		assert.deepStrictEqual(
			cloneIncompleteStatus(
				{
					getSync() {
						throw new Error('closed');
					},
				},
				'leader'
			),
			{ state: 'unknown', reason: 'unreadable-marker' }
		);
	});

	it('preserves an invalid marker through a clean copy finalization', () => {
		const store = memoryStore();
		store.rows.set(encodedKey([Symbol.for('cloneCopyDrop'), 'leader']), { count: 1 });
		store.putSync([Symbol.for('copyCursor'), 7], { copyStartTime: 100, afterKey: 'row-9' });

		const integrity = beginCloneCopyIntegrityPass(store, 'leader', 100, 1);
		assert.deepStrictEqual(integrity, { dropCount: 0, preserveUnknown: true });
		assert.equal(
			finishCloneCopyMetadata(store, 'leader', 7, 100, integrity.dropCount, 'attempt-1', 2, integrity.preserveUnknown),
			'unchanged'
		);
		assert.deepStrictEqual(cloneIncompleteStatus(store, 'leader'), {
			state: 'unknown',
			reason: 'invalid-marker',
		});
		assert.equal(store.getSync([Symbol.for('copyCursor'), 7]), undefined);
	});
});
