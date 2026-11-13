import assert from 'node:assert';
import {
	DEFAULT_DRAIN_TIMEOUT_MS,
	FENCE_OPERATION,
	RECEIPT_OPERATION,
	drainNode,
	drainTimeoutMs,
	receiptShortfall,
} from '#src/replication/nodeRemoval';

const T = 1_790_000_000_000;
const drain = { target: T, generation: 'gen-1', sharded: false, peers: ['p1'] };
const holds = { closedFloor: T + 1, originGeneration: 'gen-1', fullCoverage: true };

describe('receiptShortfall (harper-pro#1348)', () => {
	it('accepts a generation-matched floor at or above the target on a route that carries every table', () => {
		assert.equal(receiptShortfall(holds, drain), undefined);
		assert.equal(receiptShortfall({ ...holds, closedFloor: T }, drain), undefined);
	});

	it('names what a floor that proves nothing lacks', () => {
		const cases = [
			[undefined, /no certified floor/],
			[{ closedFloor: null }, /no certified floor/],
			[{ ...holds, closedFloor: T - 1 }, /below the target/],
			[{ ...holds, floorRevoked: true }, /revoked/],
			[{ ...holds, partialHistory: true }, /partial history/],
			[{ ...holds, hole: true }, /partial history/],
			[{ ...holds, originGeneration: 'gen-0' }, /another generation/],
			[{ ...holds, originGeneration: undefined }, /another generation/],
			[{ ...holds, fullCoverage: false }, /does not carry every table/],
		];
		for (const [answer, reason] of cases) assert.match(receiptShortfall(answer, drain), reason, JSON.stringify(answer));
	});

	it('accepts a route between shards, which never carries every table, for a sharded database', () => {
		assert.equal(receiptShortfall({ ...holds, fullCoverage: false }, { ...drain, sharded: true }), undefined);
	});
});

describe('drainTimeoutMs', () => {
	it('defaults, and refuses a value that is not a positive integer of milliseconds', () => {
		assert.equal(drainTimeoutMs(undefined), DEFAULT_DRAIN_TIMEOUT_MS);
		assert.equal(drainTimeoutMs(5000), 5000);
		for (const value of [0, -5, 1.5, '100', Infinity, 1e12])
			assert.throws(() => drainTimeoutMs(value), /timeout must be/);
	});
});

describe('drainNode', () => {
	const fence = (epoch = 'e1', target = T) => ({
		node: 'leaving',
		epoch,
		state: 'fenced',
		databases: { data: { target, generation: 'gen-1', sharded: false, peers: ['p1', 'p2'] } },
	});

	function transport(handlers) {
		const calls = [];
		const send = async (node, operation, options) => {
			calls.push({ node, operation, options });
			return handlers(node, operation);
		};
		send.calls = calls;
		return send;
	}

	it('finalizes once every required peer holds a floor at or above the target', async () => {
		const send = transport((node, operation) => {
			if (operation.operation === FENCE_OPERATION)
				return operation.finalize ? { ...fence(), state: 'removing' } : fence();
			assert.equal(operation.operation, RECEIPT_OPERATION);
			assert.deepEqual(operation.databases, ['data']);
			return { data: holds };
		});
		const result = await drainNode('leaving', { name: 'leaving' }, 5000, send, async (peer) => ({ name: peer }));
		assert.equal(result.state, 'removing');
		const finalize = send.calls.find(({ operation }) => operation.finalize);
		assert.deepEqual(finalize.operation, {
			operation: FENCE_OPERATION,
			node: 'leaving',
			finalize: 'e1',
			databases: ['data'],
		});
		assert.ok(send.calls.every(({ options }) => options.timeoutMs > 0 && options.timeoutMs <= 30_000));
	});

	it('waits for a peer whose floor is still below the target', async () => {
		let receipts = 0;
		const send = transport((node, operation) => {
			if (operation.operation === FENCE_OPERATION) return fence();
			receipts++;
			return { data: node.name === 'p2' && receipts < 4 ? { ...holds, closedFloor: T - 1 } : holds };
		});
		await drainNode('leaving', { name: 'leaving' }, 10_000, send, async (peer) => ({ name: peer }));
		assert.ok(receipts >= 4);
	});

	it('times out naming each shortfall, without finalizing', async () => {
		const send = transport((node, operation) => {
			if (operation.operation === FENCE_OPERATION) return fence();
			if (node.name === 'p2') throw new Error('connect ECONNREFUSED');
			return { data: { ...holds, closedFloor: T - 1 } };
		});
		await assert.rejects(
			drainNode('leaving', { name: 'leaving' }, 1200, send, async (peer) => ({ name: peer })),
			(error) => {
				assert.equal(error.statusCode, 504);
				assert.match(error.message, /p1 has its floor at .* below the target/);
				assert.match(error.message, /p2 could not be asked for its receipt/);
				assert.match(error.message, /still refuses local writes and stays a member/);
				return true;
			}
		);
		assert.ok(!send.calls.some(({ operation }) => operation.finalize));
	});

	it('keeps trying a node it cannot reach, then times out telling the operator about force', async () => {
		let calls = 0;
		const send = transport(() => {
			throw new Error(
				++calls % 2
					? 'connect ECONNREFUSED'
					: `${FENCE_OPERATION} to wss://10.0.0.9:9933 did not answer within 30ms; its outcome there is unknown`
			);
		});
		await assert.rejects(
			drainNode('leaving', { name: 'leaving' }, 2500, send, async () => ({})),
			(error) => {
				assert.equal(error.statusCode, 504);
				assert.match(error.message, /leaving could not be reached to fence it/);
				assert.match(error.message, /force: true/);
				return true;
			}
		);
		assert.ok(calls >= 2, 'a call that timed out is retried, not read as an unsupported operation');
	});

	it('refuses at once a node that does not know the fence operation, or refuses to fence', async () => {
		const unknown = transport(() => {
			throw new Error(`Operation '${FENCE_OPERATION}' not found`);
		});
		await assert.rejects(
			drainNode('leaving', {}, 60_000, unknown, async () => ({})),
			(error) => {
				assert.equal(error.statusCode, 400);
				assert.match(error.message, /cannot drain its writes before removal/);
				return true;
			}
		);
		assert.equal(unknown.calls.length, 1);
		const refused = transport(() => {
			throw new Error('ClientError: leaving is the only owner of shard 1 of database data');
		});
		await assert.rejects(
			drainNode('leaving', {}, 60_000, refused, async () => ({})),
			/only owner of shard 1/
		);
		assert.equal(refused.calls.length, 1);
	});

	it('waits only for peers that receive the database from the node, and counts those that hold its writes', async () => {
		const send = transport((node, operation) => {
			if (operation.operation === FENCE_OPERATION)
				return operation.finalize ? { ...fence(), state: 'removing' } : fence();
			return { data: node.name === 'p2' ? { closedFloor: null, receives: false } : holds };
		});
		const result = await drainNode('leaving', { name: 'leaving' }, 5000, send, async (peer) => ({ name: peer }));
		assert.deepEqual(result.databases.data.peers, ['p1']);
	});

	it('refuses when no peer the node sends a database to subscribes to it', async () => {
		const send = transport((node, operation) => {
			if (operation.operation === FENCE_OPERATION) return fence();
			return { data: { closedFloor: null, receives: false } };
		});
		await assert.rejects(
			drainNode('leaving', { name: 'leaving' }, 5000, send, async (peer) => ({ name: peer })),
			(error) => {
				assert.equal(error.statusCode, 409);
				assert.match(error.message, /No peer of leaving receives database data/);
				assert.match(error.message, /leaving accepts local writes again/);
				return true;
			}
		);
		assert.ok(!send.calls.some(({ operation }) => operation.finalize));
		assert.ok(
			send.calls.some(({ operation }) => operation.cancel === true),
			'the refused drain lifts its fence'
		);
	});

	it('never calls a peer with less than a usable budget left, keeping the last complete round', async () => {
		const send = transport(async (node, operation) => {
			if (operation.operation === FENCE_OPERATION) return fence();
			await new Promise((resolve) => setTimeout(resolve, 200));
			return { data: { ...holds, closedFloor: T - 1 } };
		});
		await assert.rejects(
			drainNode('leaving', { name: 'leaving' }, 1500, send, async (peer) => ({ name: peer })),
			(error) => {
				assert.equal(error.statusCode, 504);
				assert.match(error.message, /p1 has its floor at .* below the target/);
				assert.match(error.message, /p2 has its floor at .* below the target/);
				return true;
			}
		);
		assert.ok(
			send.calls.every(({ options }) => options.timeoutMs >= 250),
			JSON.stringify(send.calls.map((c) => c.options))
		);
	});

	it('removes a node with no database but system without a finalize', async () => {
		const send = transport(() => ({ node: 'leaving', epoch: 'e1', state: 'fenced', databases: {} }));
		const result = await drainNode('leaving', {}, 5000, send, async () => ({}));
		assert.equal(result.state, 'removing');
		assert.equal(send.calls.length, 1);
	});

	it('re-fences after a refused finalize, for a database created during the drain', async () => {
		let fences = 0;
		const send = transport((node, operation) => {
			if (operation.operation === FENCE_OPERATION) {
				if (operation.finalize && fences === 1) throw new Error('ClientError: fence changed');
				if (!operation.finalize) fences++;
				return operation.finalize ? { ...fence(), state: 'removing' } : fence();
			}
			return { data: holds };
		});
		const result = await drainNode('leaving', {}, 10_000, send, async (peer) => ({ name: peer }));
		assert.equal(result.state, 'removing');
		assert.equal(fences, 2);
	});
});
