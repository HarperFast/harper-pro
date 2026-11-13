import assert from 'node:assert';
import { parseConfirmationDefault, registerConfirmationDefaults } from '#src/replication/knownNodes';

describe('replication confirmation defaults', () => {
	it('reads an absent key as 0', () => {
		for (const raw of [undefined, null, ''])
			assert.strictEqual(parseConfirmationDefault('replication.confirmation', raw), 0);
	});

	it('accepts non-negative integers, as numbers or integer strings', () => {
		assert.strictEqual(parseConfirmationDefault('replication.confirmation', 0), 0);
		assert.strictEqual(parseConfirmationDefault('replication.confirmation', 2), 2);
		for (const raw of [' 1 ', '1.0', '+1', '1e0'])
			assert.strictEqual(parseConfirmationDefault('replication.recordLockConfirmation', raw), 1, raw);
	});

	it('throws on any other value rather than turning confirmation off', () => {
		for (const raw of [-1, 1.5, Number.NaN, 'one', '-1', '1.5', true, {}, Number.MAX_SAFE_INTEGER + 1])
			assert.throws(
				() => parseConfirmationDefault('replication.recordLockConfirmation', raw),
				/Invalid replication\.recordLockConfirmation .*: expected a non-negative integer/
			);
	});

	it('registers the values a clone installs, read through the given source', () => {
		const installed = { replication_confirmation: 2, replication_recordLockConfirmation: '1' };
		registerConfirmationDefaults((key) => installed[key]);
		assert.throws(() => registerConfirmationDefaults(() => -1), /Invalid replication\.confirmation/);
		registerConfirmationDefaults(() => undefined);
	});
});
