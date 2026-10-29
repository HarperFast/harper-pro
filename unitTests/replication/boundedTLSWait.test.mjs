import assert from 'node:assert';
import { createBoundedTLSWait } from '#src/replication/replicationConnection';

const BOUND = 50;

// a selector whose `.ready` the test settles, counting the reactions attached to it
function controlledSelector() {
	const selector = { reactions: 0, attempts: 0 };
	selector.reset = () => {
		selector.attempts++;
		selector.ready = new Promise((resolve, reject) => Object.assign(selector, { resolve, reject }));
		const then = selector.ready.then.bind(selector.ready);
		// oxlint-disable-next-line unicorn/no-thenable -- counts the reactions the wait attaches
		selector.ready.then = (...handlers) => {
			selector.reactions++;
			return then(...handlers);
		};
	};
	selector.initialize = () => selector.ready;
	selector.reset();
	return selector;
}

describe('createBoundedTLSWait (harper-pro#1189)', () => {
	it('fails each caller at the bound while the certificate state stays pending, attaching one reaction', async () => {
		const selector = controlledSelector();
		const wait = createBoundedTLSWait(() => selector, {}, BOUND);
		for (let i = 0; i < 5; i++) await assert.rejects(wait('a peer'), /Certificates are not available yet for a peer/);
		assert.strictEqual(selector.reactions, 1, 'callers that timed out must not stay attached to the pending promise');
	});

	it('resolves waiting callers when the state is known, then answers synchronously', async () => {
		const selector = controlledSelector();
		const wait = createBoundedTLSWait(() => selector, {}, 5000);
		const waiting = [wait('a'), wait('b')];
		selector.resolve();
		await Promise.all(waiting);
		assert.strictEqual(wait('c'), undefined);
	});

	it('rejects waiting callers with the initialization failure, and follows the next attempt', async () => {
		const selector = controlledSelector();
		const wait = createBoundedTLSWait(() => selector, {}, 5000);
		const waiting = wait('a');
		selector.reject(new Error('certificate table closing'));
		await assert.rejects(waiting, /certificate table closing/);
		selector.reset();
		const retried = wait('a');
		selector.resolve();
		await retried;
		assert.strictEqual(wait('a'), undefined);
	});
});
