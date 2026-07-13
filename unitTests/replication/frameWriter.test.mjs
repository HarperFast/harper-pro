/**
 * Coverage for `FrameWriter` — the outbound replication encode buffer extracted from the
 * `replicateOverWS` closure (harper-pro#440, W11). This is a zero-semantic-change extraction, so the
 * tests pin the on-the-wire encoding that the previous free-function version produced: the four-range
 * varint layout of `writeInt` (1/2/4/5 bytes at the 128 / 0x4000 / 0x3f000000 boundaries), the raw
 * `writeBytes` copy, big-endian `writeFloat64`, and — the subtle one — that `checkRoom` grows the
 * buffer WITHOUT losing bytes already written for the in-progress message (it copies `[encodingStart,
 * position)` down to offset 0 and rebases both markers). A regression in any of these silently
 * corrupts the replication stream, so they are asserted at the byte level.
 */

import { expect } from 'chai';
import { FrameWriter } from '#src/replication/frameWriter';

// Bytes of the current in-progress message: [encodingStart, position).
const msg = (f) => Uint8Array.prototype.slice.call(f.encodingBuffer, f.encodingStart, f.position);

describe('FrameWriter', () => {
	describe('writeInt varint ranges', () => {
		const cases = [
			{ n: 0, bytes: [0x00] },
			{ n: 127, bytes: [0x7f] }, // last 1-byte value
			{ n: 128, bytes: [0x80, 0x80] }, // first 2-byte value: n | 0x8000, big-endian
			{ n: 0x3fff, bytes: [0xbf, 0xff] }, // last 2-byte value
			{ n: 0x4000, bytes: [0xc0, 0x00, 0x40, 0x00] }, // first 4-byte value: n | 0xc0000000
			{ n: 0x3effffff, bytes: [0xfe, 0xff, 0xff, 0xff] }, // last 4-byte value
			{ n: 0x3f000000, bytes: [0xff, 0x3f, 0x00, 0x00, 0x00] }, // first 5-byte value: 0xff then uint32
			{ n: 0xffffffff, bytes: [0xff, 0xff, 0xff, 0xff, 0xff] }, // max uint32
		];
		for (const { n, bytes } of cases) {
			it(`encodes ${n} as ${bytes.length} byte(s)`, () => {
				const f = new FrameWriter();
				f.writeInt(n);
				expect([...msg(f)]).to.deep.equal(bytes);
			});
		}
	});

	it('writeFloat64 writes 8 big-endian bytes that round-trip', () => {
		const f = new FrameWriter();
		f.writeFloat64(1234.5678);
		const bytes = msg(f);
		expect(bytes.length).to.equal(8);
		expect(new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0)).to.equal(1234.5678);
	});

	it('writeBytes copies the requested slice at the current position', () => {
		const f = new FrameWriter();
		f.writeInt(1); // leading byte so we exercise a non-zero start position
		f.writeBytes(Buffer.from([10, 20, 30, 40, 50]), 1, 4); // -> 20,30,40
		expect([...msg(f)]).to.deep.equal([1, 20, 30, 40]);
	});

	it('preserves earlier writeInt/writeBytes/writeFloat64 output in sequence', () => {
		const f = new FrameWriter();
		f.writeInt(66); // the 'B' framing byte the send loop asserts on
		f.writeFloat64(42);
		f.writeInt(0x4000);
		const bytes = msg(f);
		expect(bytes[0]).to.equal(66);
		expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getFloat64(1)).to.equal(42);
		expect([...bytes.slice(9)]).to.deep.equal([0xc0, 0x00, 0x40, 0x00]);
	});

	it('checkRoom grows the buffer without losing in-progress bytes', () => {
		const f = new FrameWriter(1024);
		const initialBuffer = f.encodingBuffer;
		// Fill well past the initial 1024 so a grow is forced mid-message.
		const expected = [];
		for (let i = 0; i < 4000; i++) {
			const v = i & 0x7f; // stays 1-byte so index math is simple
			f.writeInt(v);
			expected.push(v);
		}
		expect(f.encodingBuffer).to.not.equal(initialBuffer); // it actually grew
		expect(f.encodingBuffer.length).to.be.greaterThan(1024);
		expect([...msg(f)]).to.deep.equal(expected); // every byte survived the realloc(s)
	});

	it('rebasing on grow keeps the message start at encodingStart, discarding an already-sent prefix', () => {
		const f = new FrameWriter(1024);
		// Simulate the send loop: write a first message, "send" it by advancing encodingStart.
		f.writeInt(66);
		f.encodingStart = f.position; // message flushed; new message starts here
		// Now write a large second message that forces a grow; the flushed prefix must be dropped.
		const expected = [];
		for (let i = 0; i < 3000; i++) {
			const v = (i * 7) & 0x7f;
			f.writeInt(v);
			expected.push(v);
		}
		expect(f.encodingStart).to.equal(0); // grow rebases to 0
		expect([...msg(f)]).to.deep.equal(expected); // only the second message, intact
	});
});
