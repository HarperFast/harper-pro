/**
 * Coverage for classifyReplicationDecodeError — how the replication receive path surfaces a record
 * that throws while decoding.
 *
 * harper-pro#537: the old bare `catch` skipped every decode failure silently. Decode errors reaching
 * this catch are treated as permanent (transient conditions are handled upstream; every known decode
 * source has been root-caused, so one that reaches here is unrecoverable old-version/corrupt data no
 * re-copy heals), so BOTH verdicts still skip and let the cursor advance. The classifier only chooses
 * observability: `skip-missing-structure` fires core's `decode-missing-structure` metric for a
 * genuinely-absent shared structure (harper#1163); `skip` logs any other failure loudly for
 * investigation.
 */

import { expect } from 'chai';
import { classifyReplicationDecodeError } from '#src/replication/replicationConnection';

// The two terminal message prefixes core's isMissingStructureError matches (RecordEncoder.ts).
function missingTypedStructureError() {
	return new Error('Could not find typed structure 42 in store table1');
}
function missingClassicStructureError() {
	return new Error('Record id is not defined for structure 7');
}

describe('classifyReplicationDecodeError', () => {
	it('routes a missing typed structure to the metric path (skip-missing-structure)', () => {
		expect(classifyReplicationDecodeError(missingTypedStructureError())).to.equal('skip-missing-structure');
	});

	it('routes a missing classic structure to the metric path', () => {
		expect(classifyReplicationDecodeError(missingClassicStructureError())).to.equal('skip-missing-structure');
	});

	it('routes a generic decode error to the loud-log path (skip)', () => {
		expect(classifyReplicationDecodeError(new Error('unexpected end of input'))).to.equal('skip');
	});

	it('routes the structon end-of-buffer error to the loud-log path', () => {
		// Not one of the two missing-structure prefixes, so it is not the known metriced class — it is
		// still skipped (permanent), just logged at error level rather than counted.
		expect(classifyReplicationDecodeError(new Error('Data read, but end of buffer not reached 0'))).to.equal('skip');
	});

	it('routes a non-Error throw to the loud-log path', () => {
		expect(classifyReplicationDecodeError('boom')).to.equal('skip');
		expect(classifyReplicationDecodeError(undefined)).to.equal('skip');
		expect(classifyReplicationDecodeError(null)).to.equal('skip');
	});
});
