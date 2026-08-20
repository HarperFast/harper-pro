/**
 * Coverage for `exceedsMaxPayload` — the pure oversized-frame predicate extracted from the connection
 * closure (harper-pro#711 review) so the send-or-throw decision can be pinned without a live socket. The
 * boundary is inclusive: a frame at exactly the cap is allowed; only a strictly larger one is rejected,
 * matching the ws server's own accept semantics.
 */
import { expect } from 'chai';
import { exceedsMaxPayload } from '#src/replication/replicationConnection';

describe('exceedsMaxPayload', () => {
	const cap = 100_000_000;

	it('allows a frame below the cap', () => {
		expect(exceedsMaxPayload(0, cap)).to.equal(false);
		expect(exceedsMaxPayload(cap - 1, cap)).to.equal(false);
	});

	it('allows a frame exactly at the cap (boundary is inclusive)', () => {
		expect(exceedsMaxPayload(cap, cap)).to.equal(false);
	});

	it('rejects a frame strictly above the cap', () => {
		expect(exceedsMaxPayload(cap + 1, cap)).to.equal(true);
	});

	it('honors an explicit smaller cap', () => {
		expect(exceedsMaxPayload(2_000_000, 1_000_000)).to.equal(true);
		expect(exceedsMaxPayload(500_000, 1_000_000)).to.equal(false);
	});
});
