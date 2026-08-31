import { expect } from 'chai';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { sendOperation, waitForCondition } from '../../integrationTests/cluster/clusterShared.mjs';

async function startStub(handler) {
	const server = createServer(handler);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const { port } = server.address();
	return {
		node: { operationsAPIURL: `http://127.0.0.1:${port}` },
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

describe('cluster test helpers — waitForCondition', () => {
	it("returns the probe's first truthy value and stops polling", async () => {
		let calls = 0;
		const result = await waitForCondition(
			() => {
				calls++;
				return calls < 3 ? false : `satisfied on ${calls}`;
			},
			{ pollMs: 1, timeoutMs: 5000 }
		);
		expect(result).to.equal('satisfied on 3');
		expect(calls).to.equal(3);
	});

	it('times out with the last observation the description reports', async () => {
		let observed = 0;
		const error = await waitForCondition(
			() => {
				observed++;
				return false;
			},
			{ pollMs: 1, timeoutMs: 60, description: () => `count ${observed} to reach 10` }
		).then(
			() => undefined,
			(error) => error
		);
		expect(error?.message).to.match(/^Timed out after 60ms waiting for count \d+ to reach 10$/);
		expect(observed).to.be.greaterThan(0);
	});

	it('paces the polls instead of spinning', async () => {
		let calls = 0;
		await waitForCondition(
			() => {
				calls++;
				return false;
			},
			{ pollMs: 50, timeoutMs: 200 }
		).catch(() => {});
		expect(calls).to.be.lessThan(20);
	});

	it('bounds a request that is accepted but never answered', async () => {
		const stub = await startStub(() => {
			/* accept the request and never respond */
		});
		try {
			const started = Date.now();
			const error = await waitForCondition(
				(signal) => sendOperation(stub.node, { operation: 'describe_table', table: 'load' }, { signal }),
				{ timeoutMs: 250, description: 'a node that never answers' }
			).then(
				() => undefined,
				(error) => error
			);
			expect(error?.message).to.equal('Timed out after 250ms waiting for a node that never answers');
			expect(Date.now() - started).to.be.lessThan(3000);
		} finally {
			await stub.close();
		}
	});

	it('propagates a probe error that is not the deadline', async () => {
		const stub = await startStub((request, response) => {
			response.writeHead(500, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ error: 'table not found' }));
		});
		try {
			const error = await waitForCondition(
				(signal) => sendOperation(stub.node, { operation: 'describe_table', table: 'nope' }, { signal }),
				{ timeoutMs: 5000 }
			).then(
				() => undefined,
				(error) => error
			);
			expect(error?.message).to.contain('table not found');
		} finally {
			await stub.close();
		}
	});

	it("reports the probe's own failure when it lands on the deadline", async () => {
		const error = await waitForCondition(
			async (signal) => {
				await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
				throw new Error('node answered 500');
			},
			{ timeoutMs: 50, description: 'a doomed probe' }
		).then(
			() => undefined,
			(error) => error
		);
		expect(error?.message).to.equal('Timed out after 50ms waiting for a doomed probe');
		expect(error?.cause?.message).to.equal('node answered 500');
	});

	it('aborts requests the probe left in flight when it fails', async () => {
		let probeSignal;
		const error = await waitForCondition(
			(signal) => {
				probeSignal = signal;
				throw new Error('boom');
			},
			{ timeoutMs: 5000 }
		).then(
			() => undefined,
			(error) => error
		);
		expect(error?.message).to.equal('boom');
		expect(probeSignal?.aborted).to.equal(true);
	});

	it('polls a real operations response until the count catches up', async () => {
		let recordCount = 0;
		const stub = await startStub((request, response) => {
			recordCount += 5;
			response.writeHead(200, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ record_count: recordCount }));
		});
		try {
			let last = 0;
			const caughtUp = await waitForCondition(
				async (signal) => {
					const { record_count } = await sendOperation(
						stub.node,
						{ operation: 'describe_table', table: 'load' },
						{ signal }
					);
					last = record_count;
					return last >= 15 && last;
				},
				{ pollMs: 1, timeoutMs: 5000, description: () => `record_count ${last} to reach 15` }
			);
			expect(caughtUp).to.equal(15);
		} finally {
			await stub.close();
		}
	});
});
