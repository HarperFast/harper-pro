import assert from 'node:assert';
import { pack } from 'msgpackr';
import {
	beginCloneCopyIntegrityPass,
	cloneIncompleteStatus,
	finishCloneCopyMetadata,
	readRemoteNodeId,
	recordCloneCopyDrop,
} from '#src/replication/cloneCopyIntegrity';

const symbolName = (value) => (typeof value === 'symbol' ? Symbol.keyFor(value) : value);
const encodedKey = (key) => JSON.stringify(key.map(symbolName));

function memoryStore() {
	const rows = new Map();
	const operations = [];
	return {
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
				return callback();
			} catch (error) {
				rows.clear();
				for (const [key, value] of snapshot) rows.set(key, value);
				throw error;
			}
		},
	};
}

describe('clone copy integrity', () => {
	it('records and finalizes an incomplete copy', async () => {
		const store = memoryStore();
		assert.deepStrictEqual(beginCloneCopyIntegrityPass(store, 7, 100, 1), { dropCount: 0 });
		await recordCloneCopyDrop(store, 7, 100, 'widgets', 'undecodable record', 2);
		assert.strictEqual(cloneIncompleteStatus(store, 7).state, 'pending');

		finishCloneCopyMetadata(store, 7, 100, 3, 'attempt-1', 3);
		assert.deepStrictEqual(cloneIncompleteStatus(store, 7), {
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

	it('inherits a drop when the same copy anchor resumes', async () => {
		const store = memoryStore();
		await recordCloneCopyDrop(store, 7, 100, 'widgets', 'undecodable record', 2);
		finishCloneCopyMetadata(store, 7, 100, 1, 'attempt-1', 3);

		assert.deepStrictEqual(beginCloneCopyIntegrityPass(store, 7, 100, 4), { dropCount: 1 });
		assert.strictEqual(cloneIncompleteStatus(store, 7).state, 'incomplete');
	});

	it('keeps the old evidence while a different-anchor repair runs, then clears it', async () => {
		const store = memoryStore();
		await recordCloneCopyDrop(store, 7, 100, 'widgets', 'undecodable record', 2);
		finishCloneCopyMetadata(store, 7, 100, 1, 'attempt-1', 3);

		assert.deepStrictEqual(beginCloneCopyIntegrityPass(store, 7, 200, 4), { dropCount: 0 });
		assert.deepStrictEqual(cloneIncompleteStatus(store, 7), {
			state: 'repairing',
			table: 'widgets',
			reason: 'undecodable record',
			detectedAt: 2,
			count: 1,
			copyStartTime: 100,
			finalizedAt: 3,
			repairAnchor: 200,
		});

		finishCloneCopyMetadata(store, 7, 200, 0, 'attempt-2', 5);
		assert.strictEqual(cloneIncompleteStatus(store, 7), undefined);
	});

	it('does not let a clean copy from another source clear the leader marker', async () => {
		const store = memoryStore();
		await recordCloneCopyDrop(store, 7, 100, 'widgets', 'undecodable record', 2);
		finishCloneCopyMetadata(store, 7, 100, 1, 'attempt-1', 3);

		beginCloneCopyIntegrityPass(store, 8, 200, 4);
		finishCloneCopyMetadata(store, 8, 200, 0, undefined, 5);
		assert.strictEqual(cloneIncompleteStatus(store, 7).state, 'incomplete');
		assert.strictEqual(cloneIncompleteStatus(store, 8), undefined);
	});

	it('orders integrity disposition before copy completion and cursor removal', async () => {
		const store = memoryStore();
		await recordCloneCopyDrop(store, 7, 100, 'widgets', 'undecodable record', 2);
		store.operations.length = 0;

		finishCloneCopyMetadata(store, 7, 100, 1, 'attempt-1', 3);
		assert.deepStrictEqual(store.operations, [
			['transactionSync'],
			['putSync', 'cloneCopyDrop'],
			['putSync', 'cloneCopyComplete'],
			['removeSync', 'copyCursor'],
		]);
	});

	it('keeps repair evidence and the resume cursor when final metadata cannot commit', async () => {
		const store = memoryStore();
		await recordCloneCopyDrop(store, 7, 100, 'widgets', 'undecodable record', 2);
		finishCloneCopyMetadata(store, 7, 100, 1, 'attempt-1', 3);
		beginCloneCopyIntegrityPass(store, 7, 200, 4);
		store.putSync([Symbol.for('copyCursor'), 7], { copyStartTime: 200, afterKey: 'row-9' });
		const putSync = store.putSync;
		store.putSync = (key, value) => {
			if (key[0] === Symbol.for('cloneCopyComplete')) throw new Error('disk full');
			return putSync(key, value);
		};

		assert.throws(() => finishCloneCopyMetadata(store, 7, 200, 0, 'attempt-2', 5), /disk full/);
		assert.strictEqual(cloneIncompleteStatus(store, 7).state, 'repairing');
		assert.deepStrictEqual(store.getSync([Symbol.for('copyCursor'), 7]), {
			copyStartTime: 200,
			afterKey: 'row-9',
		});
	});

	it('surfaces malformed and unreadable markers as unknown', () => {
		const malformed = memoryStore();
		malformed.rows.set(encodedKey([Symbol.for('cloneCopyDrop'), 7]), { count: 1 });
		assert.deepStrictEqual(cloneIncompleteStatus(malformed, 7), {
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
				7
			),
			{ state: 'unknown', reason: 'unreadable-marker' }
		);
	});

	it('reads an existing source mapping without invoking a mutating store method', () => {
		const encoded = pack({ remoteNameToId: { leader: 7 } });
		const auditStore = {
			getBinary(key) {
				assert.strictEqual(key, Symbol.for('remote-ids'));
				return encoded;
			},
			putSync() {
				assert.fail('status lookup must be read-only');
			},
		};

		assert.strictEqual(readRemoteNodeId(auditStore, 'leader'), 7);
	});

	it('returns no source id for missing, malformed, or unreadable mappings', () => {
		assert.strictEqual(readRemoteNodeId({ getBinary: () => undefined }, 'leader'), undefined);
		assert.strictEqual(
			readRemoteNodeId({ getBinary: () => pack({ remoteNameToId: { leader: '7' } }) }, 'leader'),
			undefined
		);
		assert.strictEqual(
			readRemoteNodeId(
				{
					getBinary() {
						throw new Error('closed');
					},
				},
				'leader'
			),
			undefined
		);
	});
});
