/**
 * `createRepairInflater` feeds a stored-codec (raw deflate) repair delivery to `repairBlobFile`, which
 * counts uncompressed bytes. Its two obligations: a repair that declines destroys the receive stream,
 * and that must settle quietly instead of surfacing as an unhandled inflater error; and a peer body
 * must not inflate past the size the repair expects.
 */
import assert from 'node:assert';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { deflateSync } from 'node:zlib';
import { createRepairInflater } from '#src/replication/replicationConnection';

async function collect(stream) {
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	return Buffer.concat(chunks);
}

describe('createRepairInflater', () => {
	it('inflates a well-formed body to exactly its expected size', async () => {
		const payload = Buffer.from('repair inflater payload '.repeat(3000));
		const source = new PassThrough();
		const inflated = createRepairInflater(source, payload.length);
		source.end(deflateSync(payload));
		assert.deepEqual(await collect(inflated), payload);
	});

	it('settles quietly when the receive stream is destroyed by a declined repair', async () => {
		const source = new PassThrough();
		const inflated = createRepairInflater(source, 1000);
		let uncaught;
		const onUncaught = (error) => (uncaught = error);
		process.once('uncaughtException', onUncaught);
		try {
			source.destroy(new Error('Blob repair deferred'));
			await new Promise((resolve) => inflated.on('close', resolve));
			await new Promise((resolve) => setImmediate(resolve));
		} finally {
			process.removeListener('uncaughtException', onUncaught);
		}
		assert.equal(uncaught, undefined);
		assert.equal(inflated.destroyed, true);
	});

	it('fails a body that inflates past the expected size instead of draining it', async () => {
		const bomb = deflateSync(Buffer.alloc(16 * 1024 * 1024));
		const source = new PassThrough();
		const inflated = createRepairInflater(source, 1000);
		let emitted = 0;
		inflated.on('data', (chunk) => (emitted += chunk.length));
		source.end(bomb);
		const [error] = await once(inflated, 'error');
		assert.match(error.message, /inflates past its expected size of 1000/);
		assert.ok(emitted <= 1000, `emitted ${emitted} bytes past the bound`);
		assert.equal(source.destroyed, true);
	});
});
