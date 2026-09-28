/**
 * The cursorless resume start must stay the harper-pro#428 full copy (the override is undefined) unless
 * HARPER_TEST_DISABLE_CURSORLESS_FULL_COPY=1 deliberately restores the pre-#428 non-leader `now - 60s` start.
 */

import { expect } from 'chai';
import { maybeLegacyCursorlessResumeStartForTest } from '#src/replication/replicationConnection';

const HOOK = 'HARPER_TEST_DISABLE_CURSORLESS_FULL_COPY';
const NOW = 1_700_000_000_000;

describe('maybeLegacyCursorlessResumeStartForTest', () => {
	let previous;
	beforeEach(() => {
		previous = process.env[HOOK];
		delete process.env[HOOK];
	});
	afterEach(() => {
		if (previous === undefined) delete process.env[HOOK];
		else process.env[HOOK] = previous;
	});

	it('supplies no override for leader or non-leader sources when the hook is unset', () => {
		expect(maybeLegacyCursorlessResumeStartForTest(true, NOW)).to.equal(undefined);
		expect(maybeLegacyCursorlessResumeStartForTest(false, NOW)).to.equal(undefined);
		expect(maybeLegacyCursorlessResumeStartForTest(undefined, NOW)).to.equal(undefined);
	});

	it('treats any value other than "1" as unset', () => {
		for (const value of ['0', 'true', 'yes', '']) {
			process.env[HOOK] = value;
			expect(maybeLegacyCursorlessResumeStartForTest(false, NOW), `value ${JSON.stringify(value)}`).to.equal(undefined);
		}
	});

	it('restores the pre-#428 now-60s start for a non-leader source when set to 1', () => {
		process.env[HOOK] = '1';
		expect(maybeLegacyCursorlessResumeStartForTest(false, NOW)).to.equal(NOW - 60000);
		expect(maybeLegacyCursorlessResumeStartForTest(undefined, NOW)).to.equal(NOW - 60000);
	});

	it('supplies no override for a leader even when set to 1', () => {
		process.env[HOOK] = '1';
		expect(maybeLegacyCursorlessResumeStartForTest(true, NOW)).to.equal(undefined);
	});
});
