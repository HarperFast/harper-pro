import { expect } from 'chai';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { text } from 'node:stream/consumers';
import { sendOperation, ensureTableExists, waitForCondition } from '../../integrationTests/cluster/clusterShared.mjs';

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
		const error = await waitForCondition(
			() => {
				// bails out rather than letting a lost delay spin until the deadline can never fire
				if (++calls > 20) throw new Error(`spun ${calls} times in 200ms`);
				return false;
			},
			{ pollMs: 50, timeoutMs: 200 }
		).then(
			() => undefined,
			(error) => error
		);
		expect(error?.message).to.contain('Timed out after 200ms');
		expect(calls).to.be.lessThan(20);
	});

	it('surfaces the timeout even when the description throws', async () => {
		const error = await waitForCondition(() => false, {
			pollMs: 1,
			timeoutMs: 30,
			description: () => {
				throw new Error('bad description');
			},
		}).then(
			() => undefined,
			(error) => error
		);
		expect(error?.message).to.equal('Timed out after 30ms waiting for condition (description threw: bad description)');
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

describe('cluster test helpers — ensureTableExists', () => {
	const definition = {
		database: 'flowdb2',
		table: 'filtered',
		primary_key: 'id',
		attributes: [{ name: 'id', type: 'ID' }],
	};

	it('accepts the duplicate a peer\u2019s replicated definition produced', async () => {
		const seen = [];
		const stub = await startStub(async (request, response) => {
			const body = JSON.parse(await text(request));
			seen.push(body);
			if (seen.length === 1) {
				response.writeHead(200, { 'Content-Type': 'application/json' });
				response.end(JSON.stringify({ message: "table 'flowdb2.filtered' successfully created." }));
			} else {
				response.writeHead(400, { 'Content-Type': 'application/json' });
				response.end(JSON.stringify({ error: "Table 'filtered' already exists in 'flowdb2'" }));
			}
		});
		try {
			await ensureTableExists(stub.node, definition);
			const duplicate = await ensureTableExists(stub.node, definition);
			expect(duplicate.error).to.equal("Table 'filtered' already exists in 'flowdb2'");
			expect(seen).to.have.length(2);
			expect(seen[0].operation).to.equal('create_table');
			expect(seen[0].primary_key).to.equal('id');
		} finally {
			await stub.close();
		}
	});

	it('still fails on a 400 that names a different table', async () => {
		const stub = await startStub((request, response) => {
			response.writeHead(400, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ error: "Table 'covered' already exists in 'flowdb2'" }));
		});
		try {
			const error = await ensureTableExists(stub.node, definition).then(
				() => undefined,
				(error) => error
			);
			expect(error?.message).to.contain("Table 'covered' already exists in 'flowdb2'");
		} finally {
			await stub.close();
		}
	});

	it('still fails on an unrelated rejection', async () => {
		const stub = await startStub((request, response) => {
			response.writeHead(400, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ error: "'primary_key' is required" }));
		});
		try {
			const error = await ensureTableExists(stub.node, definition).then(
				() => undefined,
				(error) => error
			);
			expect(error?.message).to.contain("'primary_key' is required");
		} finally {
			await stub.close();
		}
	});
});
