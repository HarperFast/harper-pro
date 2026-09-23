import { expect } from 'chai';
import { repeatsQueuedDelete } from '#src/replication/replicationConnection';

describe('repeatsQueuedDelete (harper-pro#826)', () => {
	const entry = Uint8Array.from([0x13, 0, 0, 0, 3, 4, 0x70, 0x65, 0x65, 0x72, 0x42, 0x79]);

	it('matches a byte-identical delete', () => {
		expect(repeatsQueuedDelete(entry.slice(), entry)).to.equal(true);
		expect(repeatsQueuedDelete(Buffer.from(entry), Buffer.from(entry))).to.equal(true);
	});

	it('never matches when no delete is queued in this frame', () => {
		expect(repeatsQueuedDelete(undefined, entry)).to.equal(false);
	});

	it('does not match a delete that differs in any byte or in length', () => {
		const changed = entry.slice();
		changed[changed.length - 1] ^= 1;
		expect(repeatsQueuedDelete(entry, changed)).to.equal(false);
		expect(repeatsQueuedDelete(entry, entry.subarray(0, entry.length - 1))).to.equal(false);
	});
});
