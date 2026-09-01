/**
 * Coverage for the HARPER_TEST_DISABLE_CURSORLESS_FULL_COPY hook behind `cursorlessResumeStartForTest`, the
 * resume start for a source that resolved to no cursor. Unset (the production path) it must always answer 0,
 * the full-copy request harper-pro#428 introduced; set to 1 it restores the pre-#428 `now - 60s` start for a
 * non-leader source so integrationTests/cluster/relayedOriginResumeGap.test.mjs can prove it catches that loss.
 */

import { expect } from 'chai';
import { cursorlessResumeStartForTest } from '#src/replication/replicationConnection';

const HOOK = 'HARPER_TEST_DISABLE_CURSORLESS_FULL_COPY';
const NOW = 1_700_000_000_000;

describe('cursorlessResumeStartForTest', () => {
	let previous;
	beforeEach(() => {
		previous = process.env[HOOK];
		delete process.env[HOOK];
	});
	afterEach(() => {
		if (previous === undefined) delete process.env[HOOK];
		else process.env[HOOK] = previous;
	});

	it('requests a full copy (0) for leader and non-leader sources when the hook is unset', () => {
		expect(cursorlessResumeStartForTest(true, NOW)).to.equal(0);
		expect(cursorlessResumeStartForTest(false, NOW)).to.equal(0);
		expect(cursorlessResumeStartForTest(undefined, NOW)).to.equal(0);
	});

	it('treats any value other than "1" as unset', () => {
		for (const value of ['0', 'true', 'yes', '']) {
			process.env[HOOK] = value;
			expect(cursorlessResumeStartForTest(false, NOW), `value ${JSON.stringify(value)}`).to.equal(0);
		}
	});

	it('restores the pre-#428 now-60s start for a non-leader source when set to 1', () => {
		process.env[HOOK] = '1';
		expect(cursorlessResumeStartForTest(false, NOW)).to.equal(NOW - 60000);
		expect(cursorlessResumeStartForTest(undefined, NOW)).to.equal(NOW - 60000);
	});

	it('still requests a full copy from a leader when set to 1', () => {
		process.env[HOOK] = '1';
		expect(cursorlessResumeStartForTest(true, NOW)).to.equal(0);
	});
});
