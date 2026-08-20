import { spawn } from 'node:child_process';
import { strictEqual } from 'node:assert';
import { suite, test } from 'node:test';

const runnerPid = process.ppid;
const leakedChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { stdio: 'ignore' });
setInterval(() => {
	try {
		process.kill(runnerPid, 0);
	} catch {
		leakedChild.kill();
		process.exit();
	}
}, 25);

suite('failing leaked-child fixture', () => {
	test('fails and leaks a child', () => {
		strictEqual('actual', 'expected');
	});
});
