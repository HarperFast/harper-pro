/**
 * Coverage for computeCopyDeliveryShortfall — the COPY_COMPLETE delivery check (#537).
 *
 * The sender tallies records it actually sent per table during a copy session and ships the tally
 * on COPY_COMPLETE; the receiver tallies records that arrived intact (decoded, or intentionally
 * dropped by policy). Both sides count the same stream, so the comparison is exact and immune to
 * concurrent writes, eviction, and resume — unlike a point-in-time table count, which races live
 * writes and reads an estimate. A deficit means records were lost in transit or dropped
 * undecodable on the receiver (the decode path logs and skips those, letting the cursor advance
 * past them). Alert-only by design: a forced re-copy would loop forever against permanently
 * undecodable records.
 */

import { expect } from 'chai';
import { computeCopyDeliveryShortfall } from '#src/replication/replicationConnection';

describe('computeCopyDeliveryShortfall', () => {
	it('reports nothing when every table matches', () => {
		expect(computeCopyDeliveryShortfall({ dogs: 100, cats: 0 }, { dogs: 100, cats: 0 })).to.deep.equal([]);
	});

	it('reports nothing for an empty sent tally (old sender or empty copy)', () => {
		expect(computeCopyDeliveryShortfall({}, { dogs: 5 })).to.deep.equal([]);
	});

	it('reports a deficit with both counts', () => {
		expect(computeCopyDeliveryShortfall({ dogs: 100 }, { dogs: 97 })).to.deep.equal([
			{ table: 'dogs', sent: 100, received: 97 },
		]);
	});

	it('treats a table absent from the received tally as zero delivered', () => {
		expect(computeCopyDeliveryShortfall({ dogs: 3 }, {})).to.deep.equal([{ table: 'dogs', sent: 3, received: 0 }]);
	});

	it('does not report a table the sender sent nothing for', () => {
		expect(computeCopyDeliveryShortfall({ dogs: 0 }, {})).to.deep.equal([]);
	});

	it('ignores tables only the receiver saw (renames, older senders)', () => {
		expect(computeCopyDeliveryShortfall({ dogs: 2 }, { dogs: 2, cats: 9 })).to.deep.equal([]);
	});

	it('never reports a surplus as a shortfall', () => {
		expect(computeCopyDeliveryShortfall({ dogs: 2 }, { dogs: 5 })).to.deep.equal([]);
	});

	it('ignores malformed sent counts', () => {
		expect(computeCopyDeliveryShortfall({ dogs: -1, cats: NaN, fish: '7', birds: 2 }, { birds: 1 })).to.deep.equal([
			{ table: 'birds', sent: 2, received: 1 },
		]);
	});

	it('reports multiple shortfalls in sent-tally order', () => {
		expect(computeCopyDeliveryShortfall({ a: 10, b: 5, c: 1 }, { a: 10, b: 0, c: 0 })).to.deep.equal([
			{ table: 'b', sent: 5, received: 0 },
			{ table: 'c', sent: 1, received: 0 },
		]);
	});
});
