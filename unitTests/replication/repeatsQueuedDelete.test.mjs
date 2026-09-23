import { expect } from 'chai';
import { repeatsQueuedDelete } from '#src/replication/replicationConnection';

describe('repeatsQueuedDelete (harper-pro#826)', () => {
	const entry = Uint8Array.from([0x13, 0, 0, 0, 3, 4, 0x70, 0x65, 0x65, 0x72, 0x42, 0x79]);
	const queue = (bytes) => {
		const queued = Buffer.alloc(64, 0xff);
		queued.set(bytes);
		return queued;
	};

	it('matches a byte-identical delete', () => {
		expect(repeatsQueuedDelete(queue(entry), entry.length, entry, 0)).to.equal(true);
		expect(repeatsQueuedDelete(queue(entry), entry.length, Buffer.from(entry), 0)).to.equal(true);
	});

	it('compares from the entry start, past a stripped prefix', () => {
		const prefixed = Uint8Array.from([0x42, 1, 2, 3, 4, 5, 6, 7, ...entry]);
		expect(repeatsQueuedDelete(queue(entry), entry.length, prefixed, 8)).to.equal(true);
	});

	it('never matches when no delete is queued in this frame', () => {
		expect(repeatsQueuedDelete(queue(entry), -1, entry, 0)).to.equal(false);
	});

	it('does not match a delete that differs in any byte or in length', () => {
		const changed = entry.slice();
		changed[changed.length - 1] ^= 1;
		expect(repeatsQueuedDelete(queue(entry), entry.length, changed, 0)).to.equal(false);
		expect(repeatsQueuedDelete(queue(entry), entry.length, entry.subarray(0, entry.length - 1), 0)).to.equal(false);
		expect(repeatsQueuedDelete(queue(entry), entry.length - 1, entry, 0)).to.equal(false);
	});
});
