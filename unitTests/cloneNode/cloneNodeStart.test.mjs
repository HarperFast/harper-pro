import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getHdbBasePath, setHdbBasePath } from '#src/core/utility/environment/environmentManager';

const ENV_KEYS = [
	'HDB_LEADER_URL',
	'HDB_LEADER_TOKEN',
	'HDB_LEADER_USERNAME',
	'HDB_LEADER_PASSWORD',
	'ROOTPATH',
	'FORCE_CLONE',
	'HARPER_CLONE_ATTEMPT',
	'HARPER_CLONE_COMPLETED_AT',
];

describe('cloneNode start (harper-pro#1239)', () => {
	let leader;
	let requests;
	let rootPath;
	let priorEnv;
	let priorBasePath;

	before(async () => {
		requests = [];
		leader = createServer((request, response) => {
			requests.push(request.url);
			response.writeHead(500, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ error: 'the clone must not reach the leader' }));
		});
		await new Promise((resolve) => leader.listen(0, '127.0.0.1', resolve));
		rootPath = mkdtempSync(join(tmpdir(), 'harper-clone-start-'));
		priorBasePath = getHdbBasePath();
		priorEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
		for (const key of ENV_KEYS) delete process.env[key];
		process.env.HDB_LEADER_URL = `http://127.0.0.1:${leader.address().port}`;
		process.env.HDB_LEADER_TOKEN = 'stub-token';
		process.env.ROOTPATH = rootPath;
	});

	after(async () => {
		for (const [key, value] of Object.entries(priorEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		setHdbBasePath(priorBasePath);
		rmSync(rootPath, { recursive: true, force: true });
		await new Promise((resolve) => leader.close(resolve));
	});

	it('stops before contacting the leader when the clone attempt marker cannot be persisted', async () => {
		// A directory at the marker path fails the rename whatever the process's privileges.
		mkdirSync(join(rootPath, '.cloneAttempt.json'));
		// The module reads the leader and root from the environment when it loads, so load a fresh copy now.
		const { cloneNode } = await import(`${import.meta.resolve('#src/cloneNode/cloneNode')}?marker-persist-failure`);

		await assert.rejects(cloneNode(), (error) => {
			assert.match(error.message, /Could not persist the clone attempt marker at .*\.cloneAttempt\.json/);
			assert.ok(error.cause, 'the filesystem error is kept as the cause');
			return true;
		});
		assert.deepEqual(requests, [], 'the clone did not reach the leader');
		assert.equal(process.env.HARPER_CLONE_ATTEMPT, undefined);
		assert.deepEqual(readdirSync(rootPath), ['.cloneAttempt.json'], 'no temporary marker file is left behind');
	});
});
