/**
 * Coverage for classifyReplicationDecodeError — how the replication receive path surfaces a record
 * that throws while decoding.
 *
 * harper-pro#537: the old bare `catch` skipped every decode failure silently. Genuine decode errors
 * are permanent (every known source has been root-caused as unrecoverable data no re-copy heals);
 * the two skip verdicts advance the cursor and differ only in observability:
 * `skip-missing-structure` fires core's `decode-missing-structure` metric for a genuinely-absent
 * shared structure (harper#1163); `skip` logs any other failure loudly for investigation.
 *
 * harper-pro#715: `hold-blob-setup` is the exception — a `BlobSetupError` marks a sync throw from
 * `receiveBlobs`'s setup (a local, typically transient blob-store fault, not an undecodable value),
 * and the caller holds and reconnects instead of sealing a deliverable record under the cursor.
 */

import { expect } from 'chai';
import { BlobSetupError, classifyReplicationDecodeError } from '#src/replication/replicationConnection';

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

	it('routes a tagged blob-setup fault to the hold path (harper-pro#715)', () => {
		expect(classifyReplicationDecodeError(new BlobSetupError(new Error('EMFILE: too many open files')))).to.equal(
			'hold-blob-setup'
		);
	});

	it('holds a blob-setup fault even when its cause matches a skip class', () => {
		// The wrapper marks WHERE the error came from (blob setup, not the value decoder); the
		// cause's own shape must not demote it back to a cursor-advancing skip.
		expect(classifyReplicationDecodeError(new BlobSetupError(missingTypedStructureError()))).to.equal(
			'hold-blob-setup'
		);
	});

	it('preserves the original fault on the wrapper cause for the hold-path log', () => {
		const fault = new Error('ENOSPC: no space left on device');
		expect(new BlobSetupError(fault).cause).to.equal(fault);
	});

	it('holds on the isBlobSetupError brand even without the prototype (cross-module-instance safety)', () => {
		const branded = Object.assign(new Error('EMFILE: too many open files'), { isBlobSetupError: true });
		expect(classifyReplicationDecodeError(branded)).to.equal('hold-blob-setup');
	});
});
