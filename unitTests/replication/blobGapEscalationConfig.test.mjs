/**
 * Registration guard for the blob-gap escalation bounds (harper-pro#432), the same shape as the
 * harper-pro#395 guard: env.get resolves only names registered in core's CONFIG_PARAMS, so an
 * unregistered key would leave replication.blobGapEscalationCycles/Ms in harper-config.yaml silently
 * ignored and the compiled-in defaults (10 cycles / 30 min) always in force.
 */

import assert from 'node:assert';
import { CONFIG_PARAMS } from '#src/core/utility/hdbTerms';

describe('CONFIG_PARAMS blob-gap escalation registration (#432)', () => {
	it('resolves both bounds to their canonical config key strings', () => {
		assert.strictEqual(CONFIG_PARAMS.REPLICATION_BLOBGAPESCALATIONCYCLES, 'replication_blobGapEscalationCycles');
		assert.strictEqual(CONFIG_PARAMS.REPLICATION_BLOBGAPESCALATIONMS, 'replication_blobGapEscalationMs');
	});
});
