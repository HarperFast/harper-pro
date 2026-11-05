/**
 * On process exit a node closes its inbound replication sockets once no thread has a request in flight, so a stop
 * with a live peer is quick and clean, and a confirmed write that commits after SIGTERM is still confirmed.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, killHarper, getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { sendOperation, stopAndTeardownNodes, waitForCondition } from './clusterShared.mjs';

const fixture = join(import.meta.dirname, 'fixture-shutdown-websocket-close');
// A stop that rides the 5 s server-close timer exits after this.
const STOP_LIMIT_MS = 5000;

for (const [layout, threads, replicationThreads] of [
	['replication sockets on a pool worker, requests on an HTTP worker', 2, 1],
	['replication sockets and requests on one worker', 1, 0],
]) {
	suite(`stopping a node with a live peer (${layout})`, (ctx) => {
		const contexts = [{ name: ctx.name }, { name: ctx.name }];
		const nodes = () => contexts.map((context) => context.harper);
		let parent;
		let enteredFile;
		let commitFile;
		const start = (context) =>
			startHarper(context, {
				env: { SHUTDOWN_TEST_ENTERED_FILE: enteredFile, SHUTDOWN_TEST_COMMIT_FILE: commitFile },
				config: {
					threads: { count: threads },
					analytics: { aggregatePeriod: -1 },
					logging: { colors: false, stdStreams: false, level: 'warn' },
					replication: {
						threads: replicationThreads,
						securePort: context.harper.hostname + ':9933',
						databases: '*',
					},
				},
			});
		const connected = () =>
			waitForCondition(
				async (signal) => {
					const statuses = await Promise.all(
						nodes().map((node) => sendOperation(node, { operation: 'cluster_status' }, { signal }))
					);
					return statuses.every(
						({ connections }) =>
							connections?.length &&
							connections.every(
								({ database_sockets: sockets }) => sockets?.length && sockets.every((socket) => socket.connected)
							)
					);
				},
				{ description: 'both directions connected' }
			);
		before(async () => {
			parent = await mkdtemp(
				join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'shutdown-websocket-close-')
			);
			enteredFile = join(parent, 'entered');
			commitFile = join(parent, 'commit');
			for (const context of contexts) {
				context.harper = { hostname: await getNextAvailableLoopbackAddress() };
				context.harper.dataRootDir = await mkdtemp(
					join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
				);
				await cp(fixture, join(context.harper.dataRootDir, 'components', basename(fixture)), { recursive: true });
				await start(context);
			}
			const { operation_token: token } = await sendOperation(nodes()[0], {
				operation: 'create_authentication_tokens',
				authorization: nodes()[0].admin,
			});
			await sendOperation(nodes()[1], {
				operation: 'add_node',
				hostname: nodes()[0].hostname,
				authorization: 'Bearer ' + token,
				rejectUnauthorized: false,
			});
			await connected();
		});
		after(async () => {
			await stopAndTeardownNodes(nodes());
			await rm(parent, { recursive: true, force: true });
		});

		test('a write confirmed after SIGTERM still returns, reaches the peer, and the stop stays quick', async () => {
			const [writer, peer] = nodes();
			const child = writer.process;
			const authorization =
				'Basic ' + Buffer.from(`${writer.admin.username}:${writer.admin.password}`).toString('base64');
			const pending = fetch(`${writer.httpURL}/SlowConfirmed/late`, {
				method: 'PUT',
				signal: AbortSignal.timeout(30_000),
				headers: {
					'Content-Type': 'application/json',
					'X-Replicate-To': '*;confirm=1',
					'Authorization': authorization,
				},
				body: JSON.stringify({ id: 'late' }),
			});
			await waitForCondition(
				() =>
					readFile(enteredFile).then(
						() => true,
						() => false
					),
				{ pollMs: 50, description: 'the write is in flight' }
			);
			const exited = once(child, 'exit', { signal: AbortSignal.timeout(30_000) });
			const signalledAt = Date.now();
			child.kill('SIGTERM');
			// Long enough for a thread that closes its replication sockets at its own drain to have done so.
			await delay(300);
			await writeFile(commitFile, 'commit');
			const response = await pending;
			assert.ok(response.status >= 200 && response.status < 300, `the confirmed write returned ${response.status}`);
			await exited;
			const stopMs = Date.now() - signalledAt;
			assert.equal(child.exitCode, 0);
			assert.ok(stopMs < STOP_LIMIT_MS, `stop took ${stopMs} ms`);
			const stored = await sendOperation(peer, {
				operation: 'search_by_id',
				database: 'data',
				table: 'Confirmed',
				ids: ['late'],
				get_attributes: ['id'],
			});
			assert.equal(stored.length, 1, 'the confirming peer holds the record');
		});

		test('killHarper exits cleanly with its default grace', async () => {
			await start(contexts[0]);
			await connected();
			const children = nodes().map((node) => node.process);
			await Promise.all(contexts.map((context) => killHarper(context)));
			for (const child of children) assert.equal(child.exitCode, 0, `signal ${child.signalCode}`);
		});
	});
}
