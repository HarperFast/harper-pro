/**
 * Component-level coverage for the decode-drop fix (harper-pro#537).
 *
 * Goal: verify that the REAL error produced by a genuine missing-structure decode failure —
 * not a synthetic Error with a hand-written message — is correctly classified by
 * classifyReplicationDecodeError and routes to the decode-missing-structure metric.
 *
 * What this tests:
 *   1. A StructonPackr encoder (the same class the replication receive path uses for
 *      tableDecoder.decoder) auto-learns a typed structure when encoding an object.
 *   2. A fresh decoder that lacks that structure throws "Could not find typed structure 0"
 *      when it encounters the encoded bytes — the exact error that reaches the receive
 *      catch block in replicationConnection.ts after auditRecord.getValue(tableDecoder).
 *   3. That real error passes isMissingStructureError → true (confirming the prefix match).
 *   4. classifyReplicationDecodeError returns 'skip-missing-structure' → the receive path
 *      would route to recordAction(true, DECODE_MISSING_STRUCTURE_METRIC, ...) and a
 *      structured warn log.
 *   5. DECODE_MISSING_STRUCTURE_METRIC is the expected constant ('decode-missing-structure').
 *
 * What this does NOT cover:
 *   - The full receive-path end-to-end: the test does not spin up a replication cluster or
 *     send real replication frames. It does not verify that recordAction actually fires
 *     (only that the branch condition is true).
 *   - The readAuditEntry + getValue path: we call the StructonPackr decoder directly rather
 *     than going through an audit-entry binary; the core decode step (store.decoder.decode)
 *     is identical. A separate integration test would be needed to cover the full binary
 *     framing end-to-end.
 *   - The unknown-table-id HOLD path (close + reconnect): that is a different receive-path
 *     branch and is covered by separate integration tests.
 *
 * On the pre-#537 code:
 *   The same StructonPackr decode would throw the same error, but the bare catch block would
 *   log it as a generic error with no metric — the classify step did not exist. Contrast: on
 *   the fixed code, classifyReplicationDecodeError returns 'skip-missing-structure' and
 *   recordAction fires DECODE_MISSING_STRUCTURE_METRIC instead of a generic error log.
 */

import { expect } from 'chai';
import { Packr } from 'msgpackr';
import { createStructon } from 'structon';
import { isMissingStructureError } from '#src/core/resources/RecordEncoder';
import {
	classifyReplicationDecodeError,
	DECODE_MISSING_STRUCTURE_METRIC,
} from '#src/replication/replicationConnection';

// Replicate the StructonPackr construction from replicationConnection.ts (line ~92):
//   const StructonPackr = createStructon(Packr);
// Both the sender (RecordEncoder's StructonEncoder) and the receiver tableDecoder.decoder
// are instances of this class.  Its binary format is the one that produces
// "Could not find typed structure N" when decoding a buffer whose struct ID is absent.
const StructonPackr = createStructon(Packr);

describe('decode-drop missing-structure classification (harper-pro#537 component test)', () => {
	let encodedBytes;
	let learnedStructs;

	before(() => {
		// Build an encoder and encode a plain object. StructonPackr auto-learns a typed structure
		// (struct id 0) for the object's shape — identical to what the sender's RecordEncoder does
		// when encoding a record with randomAccessFields:true.
		const encoder = new StructonPackr({ typedStructs: [] });
		encodedBytes = encoder.encode({ id: 'row-001', f1: 'hello', f2: 42 });
		learnedStructs = encoder.typedStructs;
	});

	it('encoder auto-learns a typed structure (struct id 0)', () => {
		// Confirm the encoder now has at least one typed structure so the decode can reference it.
		expect(learnedStructs).to.be.an('array');
		expect(learnedStructs.length).to.be.greaterThan(0);
	});

	it('decoding with a fresh decoder (no structures) throws the real missing-structure error', () => {
		// A fresh tableDecoder.decoder on the receiver has NO typedStructs — it only gets them via
		// TABLE_FIXED_STRUCTURE. If that message was missed or the schema diverged, decode throws here.
		const decoder = new StructonPackr({ typedStructs: [] });

		let caughtError;
		try {
			// This mirrors the receive path's: store.decoder.decode(buffer.subarray(...), { noMetadata: true })
			// (getValue in auditStore.ts; the { noMetadata } flag skips the on-disk timestamp prefix which
			// is not present in the replication frame anyway.)
			decoder.decode(encodedBytes);
		} catch (err) {
			caughtError = err;
		}

		expect(caughtError, 'should have thrown').to.be.instanceOf(Error);
		expect(caughtError.message).to.match(
			/^Could not find typed structure 0/,
			'the real structon error must start with the expected prefix'
		);
	});

	it('isMissingStructureError recognises the real structon throw', () => {
		const decoder = new StructonPackr({ typedStructs: [] });
		let caughtError;
		try {
			decoder.decode(encodedBytes);
		} catch (err) {
			caughtError = err;
		}
		expect(isMissingStructureError(caughtError)).to.equal(
			true,
			'isMissingStructureError must return true for the real structon error so the classifier routes to the metric path'
		);
	});

	it('classifyReplicationDecodeError routes the real error to skip-missing-structure', () => {
		// This is the condition that gates the recordAction(true, DECODE_MISSING_STRUCTURE_METRIC, ...)
		// call in the receive path (replicationConnection.ts ~3517). Verifying it returns
		// 'skip-missing-structure' for the REAL error (not just synthetic ones) closes the round-trip.
		const decoder = new StructonPackr({ typedStructs: [] });
		let caughtError;
		try {
			decoder.decode(encodedBytes);
		} catch (err) {
			caughtError = err;
		}
		expect(classifyReplicationDecodeError(caughtError)).to.equal(
			'skip-missing-structure',
			'a real missing-structure decode failure must route to the metric path, not the generic error log'
		);
	});

	it('DECODE_MISSING_STRUCTURE_METRIC is the expected metric name', () => {
		// Pin the constant that the receive path passes to recordAction so a rename here is caught.
		expect(DECODE_MISSING_STRUCTURE_METRIC).to.equal('decode-missing-structure');
	});

	it('a decoder WITH the learned structures decodes correctly (control)', () => {
		// Confirm the encoding is structurally valid — a decoder provisioned with the correct
		// typedStructs decodes without error, ruling out a malformed test payload.
		const decoder = new StructonPackr({ typedStructs: learnedStructs });
		const decoded = decoder.decode(encodedBytes);
		expect(decoded).to.include({ id: 'row-001', f1: 'hello', f2: 42 });
	});
});
