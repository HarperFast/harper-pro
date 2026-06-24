/**
 * Coverage for `materializeOperationResponse`, which makes an operation's result safe to
 * send over the replication channel's single encoded message.
 *
 * The regression it guards: `get_analytics` (and other streaming ops) return their rows
 * lazily so the HTTP layer can stream — either as a lazy async-iterable or as an array of
 * unresolved per-row promises. Forwarded to a peer over replication, neither encodes safely:
 * an array of promises throws "Cannot encode a promise" (dropping the peer connection) and a
 * bare async-iterable silently encodes to `{}` (dropping every row), so a `replicated`
 * get_analytics fan-out loses the peer's rows. These assertions pin the drain at the function
 * level without spinning up a cluster.
 */

import assert from 'node:assert/strict';
import { materializeOperationResponse } from '#src/replication/materializeOperationResponse';

describe('materializeOperationResponse', () => {
	it('drains an async iterable into a { results } array (the get_analytics fan-out case)', async () => {
		async function* rows() {
			yield { id: 1, node: 'a' };
			yield { id: 2, node: 'b' };
		}
		const result = await materializeOperationResponse(rows());
		assert.deepEqual(result, {
			results: [
				{ id: 1, node: 'a' },
				{ id: 2, node: 'b' },
			],
		});
	});

	it('drains an empty async iterable to { results: [] } (the lost-peer-rows shape)', async () => {
		async function* none() {}
		assert.deepEqual(await materializeOperationResponse(none()), { results: [] });
	});

	it('resolves per-row promises yielded by an async iterable', async () => {
		async function* rows() {
			yield Promise.resolve({ id: 1 });
			yield Promise.resolve({ id: 2 });
		}
		assert.deepEqual(await materializeOperationResponse(rows()), { results: [{ id: 1 }, { id: 2 }] });
	});

	it('resolves any per-row promises an array yields', async () => {
		const result = await materializeOperationResponse([Promise.resolve({ id: 1 }), Promise.resolve({ id: 2 })]);
		assert.deepEqual(result, { results: [{ id: 1 }, { id: 2 }] });
	});

	it('wraps a plain array as { results }', async () => {
		const result = await materializeOperationResponse([{ id: 1 }]);
		assert.deepEqual(result, { results: [{ id: 1 }] });
	});

	it('drains a non-array sync iterable', async () => {
		const result = await materializeOperationResponse(new Set([{ id: 1 }, { id: 2 }]));
		assert.deepEqual(result, { results: [{ id: 1 }, { id: 2 }] });
	});

	it('passes binary through unchanged — Buffer/typed arrays are not shredded into bytes', async () => {
		const buf = Buffer.from('hello');
		assert.equal(await materializeOperationResponse(buf), buf);
		const bytes = new Uint8Array([1, 2, 3]);
		assert.equal(await materializeOperationResponse(bytes), bytes);
	});

	it('propagates an error thrown mid-stream so the boundary can return an error response', async () => {
		async function* boom() {
			yield { id: 1 };
			throw new Error('mid-stream failure');
		}
		await assert.rejects(materializeOperationResponse(boom()), /mid-stream failure/);
	});

	it('returns a plain object response unchanged (by reference)', async () => {
		const response = { message: 'ok' };
		assert.equal(await materializeOperationResponse(response), response);
	});

	it('does not drain a string into characters', async () => {
		assert.equal(await materializeOperationResponse('hello'), 'hello');
	});

	it('returns null and undefined unchanged', async () => {
		assert.equal(await materializeOperationResponse(null), null);
		assert.equal(await materializeOperationResponse(undefined), undefined);
	});
});
