import { run } from 'node:test';
import { availableParallelism } from 'node:os';
import { spec } from 'node:test/reporters';
import { writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect, parseArgs } from 'node:util';

/**
 * Custom test runner for Harper Pro integration tests.
 *
 * This exists because Node.js CLI arg parsing doesn't allow passing options like --test-shard
 * after the --test flag. Using the run() API directly gives us full control over configuration.
 */

const { values, positionals } = parseArgs({
	options: {
		concurrency: { type: 'string' },
		isolation: { type: 'string' },
		shard: { type: 'string' },
		only: { type: 'boolean' },
	},
	allowPositionals: true,
});

const CONCURRENCY =
	parseInt(process.env.HARPER_INTEGRATION_TEST_CONCURRENCY || values.concurrency, 10) ||
	Math.max(1, Math.floor(availableParallelism() / 2) + 1);

const ISOLATION = process.env.HARPER_INTEGRATION_TEST_ISOLATION || values.isolation || 'process';

const [SHARD_INDEX, SHARD_TOTAL] = (process.env.HARPER_INTEGRATION_TEST_SHARD || values.shard || '1/1')
	.split('/')
	.map((v) => parseInt(v, 10));

const ONLY = values.only ?? false;

const TEST_FILES = positionals.length > 0 ? positionals : ['integrationTests/**/*.test.mjs'];

const stream = run({
	concurrency: ISOLATION === 'none' ? undefined : CONCURRENCY,
	isolation: ISOLATION,
	globPatterns: TEST_FILES,
	only: ONLY,
	shard: {
		index: SHARD_INDEX,
		total: SHARD_TOTAL,
	},
});

const MAX_CAPTURED_FAILURES = 10;
const MAX_FAILURE_DETAIL_LENGTH = 32_768;
const failures = [];
let omittedFailureCount = 0;
const writeStderrSync = (output) => {
	const buffer = Buffer.from(output);
	let offset = 0;
	while (offset < buffer.length) {
		const written = writeSync(process.stderr.fd, buffer, offset, buffer.length - offset);
		if (written === 0) break;
		offset += written;
	}
};
stream.on('test:fail', (event) => {
	process.exitCode = 1;
	if (event?.details?.error) {
		if (failures.length < MAX_CAPTURED_FAILURES) failures.push({ name: event.name, error: event.details.error });
		else omittedFailureCount++;
	}
});

stream.on('end', () => {
	process.exit(process.exitCode || 0);
});

// Leaked-child backstop. With process isolation, the run only finalizes (emits `end`)
// once every child test process has exited. A test that leaves a Harper child alive after
// teardown (e.g. a restarted node whose new handle was never re-tracked, so `after` kills
// the dead pid and the live child outlives it) keeps that child process — and thus this
// process — alive forever. The tests have already reported pass/fail, but `end` never
// fires, so the job hangs to the runner's hard timeout (observed: 260 min on the stress
// workflow). A blanket wall-clock ceiling can't help — the soak suite legitimately runs
// ~240 min. Instead we anchor on completion: once all top-level test files have completed,
// `end` should follow within moments; if it doesn't, a child has leaked. We then force a
// loud, NON-ZERO exit, converting a silent multi-hour hang into a fast, actionable failure.
const EXIT_GRACE_MS = Number(process.env.HARPER_INTEGRATION_TEST_EXIT_GRACE_MS) || 60_000;
let enqueuedTop = 0;
let completedTop = 0;
let graceTimer = null;
const armGraceIfDone = () => {
	clearTimeout(graceTimer);
	// Equal counts mid-run (one file done before the next is scheduled) is fine: a new
	// top-level `test:enqueue` disarms the timer below, so we only fire on a true stall.
	if (enqueuedTop > 0 && completedTop >= enqueuedTop) {
		graceTimer = setTimeout(() => {
			let output = '';
			if (failures.length > 0) {
				output += '\n[run.mjs] Failure details captured before final reporting stalled:\n';
				for (const failure of failures) {
					const detail = inspect(failure.error, { colors: false, depth: null });
					output += `\n${failure.name}:\n${detail.slice(0, MAX_FAILURE_DETAIL_LENGTH)}`;
					if (detail.length > MAX_FAILURE_DETAIL_LENGTH) output += '\n[run.mjs] Failure detail truncated.';
				}
			}
			if (omittedFailureCount > 0) output += `\n[run.mjs] ${omittedFailureCount} additional failure(s) omitted.`;
			output +=
				`\n\n[run.mjs] All ${completedTop} top-level test(s) completed but the process did not ` +
				`exit within ${EXIT_GRACE_MS}ms — a child outlived teardown (open handles keeping the event ` +
				`loop alive). Forcing exit so the CI job fails fast instead of hanging to its hard timeout.\n`;
			try {
				writeStderrSync(output);
			} catch {}
			process.exit(process.exitCode || 1);
		}, EXIT_GRACE_MS);
		graceTimer.unref?.(); // never let the backstop itself hold the loop open
	}
};
// Count only real top-level tests/suites, not the per-file wrapper. Under process
// isolation each file emits a nesting-0 `test:enqueue` whose `name` identifies its `file`,
// in addition to the enqueue for the actual test/suite inside it. The file wrapper never
// emits `test:complete` when its child hangs (that's the whole failure mode), so counting
// it would keep enqueued > completed forever and the backstop would never arm. Excluding
// the wrapper leaves just the genuine tests, whose completes we can balance against.
const normalizeTestPath = (path) => {
	if (!path) return null;
	try {
		return resolve(path.startsWith('file:') ? fileURLToPath(path) : path);
	} catch {
		return null;
	}
};
const isFileWrapper = (event) => {
	const name = normalizeTestPath(event?.name);
	const file = normalizeTestPath(event?.file);
	return name !== null && name === file;
};
stream.on('test:enqueue', (e) => {
	if ((e?.nesting ?? 0) === 0 && !isFileWrapper(e)) {
		enqueuedTop++;
		clearTimeout(graceTimer); // more work scheduled — not done yet
	}
});
stream.on('test:complete', (e) => {
	if ((e?.nesting ?? 0) === 0 && !isFileWrapper(e)) {
		completedTop++;
		armGraceIfDone();
	}
});

stream.compose(spec).pipe(process.stdout);
