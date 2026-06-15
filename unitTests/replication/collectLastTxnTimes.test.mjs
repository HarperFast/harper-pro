/**
 * Coverage for collectLastTxnTimes — the dbisDB `seq` scan in sendSubscriptionRequestUpdate that
 * builds the "newest lastTxnTime per source node" map used to raise a resume start point.
 *
 * harper-pro#352 (second call site): during a rolling upgrade a `seq` row can be encoded against a
 * structure shape this node decodes differently, so the store iterator yields a `value` of `null`
 * (logged as "Error decoding record: Data read, but end of buffer not reached"). The original
 * `entry.value.nodes` deref threw a TypeError on that `null`, which escaped the subscription-setup
 * path and wedged inbound replication (1006 reconnect storm, socket connected but receiving
 * nothing). collectLastTxnTimes skips an undecodable entry instead of throwing — safe because the
 * map only ever raises a start point (a miss just re-overlaps; replication dedupes), and the `seq`
 * row self-heals on the next cursor write once the handshake can complete.
 */

import { expect } from 'chai';
import { collectLastTxnTimes } from '#src/replication/replicationConnection';

// A `seq` entry whose `value` getter throws — models a decode that throws on access rather than
// returning null (older/edge encodings). Must be skipped just like a null value.
function throwingEntry() {
	return {
		get value() {
			throw new Error('Data read, but end of buffer not reached 0');
		},
	};
}

describe('collectLastTxnTimes', () => {
	it('returns an empty map for no entries', () => {
		expect(collectLastTxnTimes([])).to.deep.equal(new Map());
	});

	it('collects the newest lastTxnTime per node across entries', () => {
		const entries = [
			{
				value: {
					seqId: 5,
					nodes: [
						{ id: 1, lastTxnTime: 100 },
						{ id: 2, lastTxnTime: 200 },
					],
				},
			},
			{ value: { seqId: 6, nodes: [{ id: 1, lastTxnTime: 150 }] } },
		];
		const map = collectLastTxnTimes(entries);
		expect(map.get(1)).to.equal(150); // raised from 100
		expect(map.get(2)).to.equal(200);
	});

	it('does not lower an already-seen lastTxnTime', () => {
		const entries = [
			{ value: { nodes: [{ id: 1, lastTxnTime: 300 }] } },
			{ value: { nodes: [{ id: 1, lastTxnTime: 50 }] } },
		];
		expect(collectLastTxnTimes(entries).get(1)).to.equal(300);
	});

	it('skips an entry that decoded to null (THE #352 crash case) and still collects the rest', () => {
		const entries = [{ value: null }, { value: { nodes: [{ id: 7, lastTxnTime: 42 }] } }];
		let map;
		expect(() => {
			map = collectLastTxnTimes(entries);
		}).to.not.throw();
		expect(map.get(7)).to.equal(42);
		expect(map.has(undefined)).to.equal(false);
	});

	it('skips an entry whose value access throws and still collects the rest', () => {
		const entries = [throwingEntry(), { value: { nodes: [{ id: 9, lastTxnTime: 99 }] } }];
		let map;
		expect(() => {
			map = collectLastTxnTimes(entries);
		}).to.not.throw();
		expect(map.get(9)).to.equal(99);
	});

	it('tolerates a decoded value with no nodes array', () => {
		const entries = [{ value: { seqId: 1 } }, { value: {} }, { value: { nodes: [] } }];
		expect(collectLastTxnTimes(entries)).to.deep.equal(new Map());
	});

	it('skips a partially-decoded row whose nodes is a non-array (object/number) instead of throwing', () => {
		const entries = [
			{ value: { nodes: {} } },
			{ value: { nodes: 5 } },
			{ value: { nodes: [{ id: 3, lastTxnTime: 7 }] } },
		];
		let map;
		expect(() => {
			map = collectLastTxnTimes(entries);
		}).to.not.throw();
		expect(map.get(3)).to.equal(7);
	});
});
