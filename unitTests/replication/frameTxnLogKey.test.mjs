/**
 * harper-pro#790: a replication frame's leading float64 is the origin's transaction-log key for every record in
 * that frame. The receiver hands it to `RocksTransaction.setTimestamp`, to the durable resume cursor
 * and to the received-version status watermark, so a value that is not a representable date must be
 * rejected before any of that: a NaN or infinite key poisons the cursor, and every reconnect would
 * wedge on the same frame. The receiver holds (closes and reconnects) rather than skipping, leaving
 * the cursor where it was, so nothing is lost when the frame was merely corrupt in transit.
 */

import { expect } from 'chai';
import { isValidFrameTxnLogKey } from '#src/replication/replicationConnection';

describe('replication frame transaction-log key validation', () => {
	it('accepts a representable date', () => {
		expect(isValidFrameTxnLogKey(Date.now())).to.equal(true);
		expect(isValidFrameTxnLogKey(1)).to.equal(true);
		// the audit clock is sub-millisecond on RocksDB, so a fractional key is ordinary
		expect(isValidFrameTxnLogKey(Date.now() + 0.0269)).to.equal(true);
		expect(isValidFrameTxnLogKey(8.64e15)).to.equal(true);
	});

	it('rejects values that cannot be a log position', () => {
		expect(isValidFrameTxnLogKey(NaN)).to.equal(false);
		expect(isValidFrameTxnLogKey(Infinity)).to.equal(false);
		expect(isValidFrameTxnLogKey(-Infinity)).to.equal(false);
		expect(isValidFrameTxnLogKey(0)).to.equal(false);
		expect(isValidFrameTxnLogKey(-1)).to.equal(false);
		// past the maximum date JavaScript can represent: `new Date(x).toISOString()` throws on it,
		// and the log-key domain is the same clock
		expect(isValidFrameTxnLogKey(8.64e15 + 1)).to.equal(false);
	});

	it('rejects a non-number, so a malformed frame cannot masquerade as a key', () => {
		expect(isValidFrameTxnLogKey(undefined)).to.equal(false);
		expect(isValidFrameTxnLogKey(null)).to.equal(false);
		expect(isValidFrameTxnLogKey('1788469796313')).to.equal(false);
	});

	it('rejects the sentinel a body too short to hold a header yields', () => {
		// The receiver reads the header only when the body actually carries 8 bytes, and substitutes NaN
		// otherwise, so a truncated frame takes the same hold-and-reconnect path as a corrupt one rather
		// than throwing a RangeError past it.
		expect(isValidFrameTxnLogKey(NaN)).to.equal(false);
	});
});
