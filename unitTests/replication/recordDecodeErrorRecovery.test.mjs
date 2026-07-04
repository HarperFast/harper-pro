/**
 * Coverage for `classifyRecordDecodeError` — the per-record value-decode recovery decision in
 * `onWSMessage`'s inner catch (around `decodeBlobsWithWrites`).
 *
 * Historically that catch logged and swallowed the error while the batch resume cursor
 * (`maxBatchVersion` → end_txn → sender `COMMITTED_UPDATE`) advanced past the un-decoded record —
 * a permanent, undetected `[error, head]` gap on the receiver, the #1163/#1453 structure-fork class
 * (harper-pro#440, epic #430 Theme B). These tests pin the deliberate decision that replaced it:
 *
 *   - decoder RESOLVED (a real record whose structures forked) → 'close', so the error re-throws
 *     onto the outer transient-close path (closeOnInboundMessageError → 1011 → reconnect + resume),
 *     which rebuilds the decoder from the peer's re-sent structures and heals the fork on resume.
 *   - decoder UNRESOLVED (unknown tableId — transient schema propagation, not a fork) → 'skip', the
 *     prior skip-and-log behavior, since a reconnect wouldn't supply the missing table def.
 */

import { expect } from 'chai';
import { classifyRecordDecodeError } from '#src/replication/replicationConnection';

describe('classifyRecordDecodeError', () => {
	it('closes on a resolved-decoder value-decode failure (structure-fork class — heals on reconnect, must not skip past)', () => {
		expect(classifyRecordDecodeError(true)).to.equal('close');
	});

	it('skips (skip-and-log) an unresolved decoder — an unknown tableId is transient schema propagation, not a fork', () => {
		expect(classifyRecordDecodeError(false)).to.equal('skip');
	});

	it('returns only the two known dispositions, keyed solely on whether the decoder resolved', () => {
		// Guards against a future edit silently introducing a third disposition or flipping the mapping:
		// the resume-cursor-safety contract depends on 'close' being the resolved-decoder outcome.
		expect([classifyRecordDecodeError(true), classifyRecordDecodeError(false)]).to.deep.equal(['close', 'skip']);
	});
});
