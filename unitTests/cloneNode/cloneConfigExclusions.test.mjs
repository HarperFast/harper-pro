import assert from 'node:assert';
import { flattenConfig } from '#src/core/config/configUtils';
import { CONFIG_TO_EXCLUDE_FROM_CLONE } from '#src/cloneNode/configExclusions';

describe('clone config exclusions', () => {
	it("does not copy the leader's private replication addresses or network", () => {
		const flattened = flattenConfig({
			replication: {
				network: 'net1',
				privateUrls: [{ url: 'wss://10.0.0.1:9933', network: 'net1' }],
				url: 'wss://leader:9933',
			},
		});
		for (const key of Object.keys(flattened))
			if (key.startsWith('replication_')) assert.ok(CONFIG_TO_EXCLUDE_FROM_CLONE[key], `${key} is copied to a clone`);
	});
});
