/**
 * Regression guard for harper-pro#395: replication_leadingDuplicateSkip was missing from
 * CONFIG_PARAMS, so env.get() always resolved undefined and the kill-switch defaulted to true
 * regardless of operator config.
 */

import { expect } from 'chai';
import { CONFIG_PARAMS } from '#src/core/utility/hdbTerms';

describe('CONFIG_PARAMS.REPLICATION_LEADINGDUPLICATESKIP', () => {
	it('is registered and resolves to the canonical config key string', () => {
		expect(CONFIG_PARAMS.REPLICATION_LEADINGDUPLICATESKIP).to.equal('replication_leadingDuplicateSkip');
	});
});
