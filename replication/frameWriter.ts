// FrameWriter encapsulates the outbound replication encode buffer: a single grow-on-demand
// Buffer plus the varint/bytes/float writers and the room check that were previously free
// variables and closures inside `replicateOverWS`. This is a mechanical extraction with zero
// semantic change (harper-pro#440, W11 of the replication epic #430) — the field layout, the
// varint encoding, and the exact grow formula in `checkRoom` are preserved byte-for-byte.
//
// `encodingStart`, `position`, and `encodingBuffer` remain public and are read/written directly
// by the send loop, which brackets each outbound message with `encodingStart = position` and
// slices `[encodingStart, position)` to hand to `ws.send`. The connection-scoped size guard
// (`checkExcessMessageSize`) stays with the connection: it only reads a length and logs peer
// identity, so it has no business owning buffer state.
//
// Note: `Buffer.allocUnsafeSlow` returns a non-pooled buffer whose backing `ArrayBuffer` is
// exactly sized with `byteOffset` 0, so the DataView can use offset 0 and the buffer length.
export class FrameWriter {
	encodingStart = 0;
	position = 0;
	encodingBuffer: Buffer;
	dataView: DataView;

	constructor(initialSize = 1024) {
		this.encodingBuffer = Buffer.allocUnsafeSlow(initialSize);
		this.dataView = new DataView(this.encodingBuffer.buffer, 0, initialSize);
	}

	// write an integer to the current buffer
	writeInt(number: number) {
		this.checkRoom(5);
		if (number < 128) {
			this.encodingBuffer[this.position++] = number;
		} else if (number < 0x4000) {
			this.dataView.setUint16(this.position, number | 0x8000);
			this.position += 2;
		} else if (number < 0x3f000000) {
			this.dataView.setUint32(this.position, number | 0xc0000000);
			this.position += 4;
		} else {
			this.encodingBuffer[this.position] = 0xff;
			this.dataView.setUint32(this.position + 1, number);
			this.position += 5;
		}
	}

	// write raw binary/bytes to the current buffer
	writeBytes(src: Buffer, start = 0, end = src.length) {
		const length = end - start;
		this.checkRoom(length);
		src.copy(this.encodingBuffer, this.position, start, end);
		this.position += length;
	}

	writeFloat64(number: number) {
		this.checkRoom(8);
		this.dataView.setFloat64(this.position, number);
		this.position += 8;
	}

	checkRoom(length: number) {
		if (length + 16 > this.encodingBuffer.length - this.position) {
			const newBuffer = Buffer.allocUnsafeSlow(((this.position + length - this.encodingStart + 0x10000) >> 10) << 11);
			this.encodingBuffer.copy(newBuffer, 0, this.encodingStart, this.position);
			this.position = this.position - this.encodingStart;
			this.encodingStart = 0;
			this.encodingBuffer = newBuffer;
			this.dataView = new DataView(this.encodingBuffer.buffer, 0, this.encodingBuffer.length);
		}
	}
}
