/**
 * Coverage for isGenuineNodeDeletion — the guard that stops a decode failure from
 * masquerading as a node deletion.
 *
 * Background (harper#1163): when an hdb_nodes record's value fails to decode (e.g. stale
 * msgpackr shared-structures), the change stream surfaces a nullish value. The old code
 * forwarded that nullish value straight to onNodeUpdate, whose `if (!node)` branch treated
 * it as a deletion and tore down EVERY one of that peer's replication subscriptions — the
 * "Node was deleted, unsubscribing from node ..." storm observed in production, which wiped
 * apparent cluster membership on the affected nodes.
 *
 * A nullish value is only a genuine deletion when the event is a real `delete` AND the
 * record is actually gone from storage. A put/patch with no decodable value, or a delete
 * whose row is still physically present, is a transient decode failure — not a removal.
 */

import { expect } from 'chai';
import { isGenuineNodeDeletion } from '#src/replication/knownNodes';

const present = () => true; // record still physically in the store
const absent = () => false; // record genuinely gone

// The helper is only reached for events with no decodable value, so it takes just the
// event type and a storage-existence probe.
describe('isGenuineNodeDeletion', () => {
	it('treats a real delete whose record is gone as a genuine deletion', () => {
		expect(isGenuineNodeDeletion('delete', absent)).to.equal(true);
	});

	it('does NOT treat a delete event as a deletion while the record is still present (decode failure)', () => {
		// This is the production case: a "delete"-shaped signal for a row that is still on
		// disk but undecodable. Tearing the peer down here is exactly the #1163 blast radius.
		expect(isGenuineNodeDeletion('delete', present)).to.equal(false);
	});

	it('does NOT treat a put with no decodable value as a deletion (regardless of storage)', () => {
		// A put always carries a value; a nullish value means it failed to decode.
		expect(isGenuineNodeDeletion('put', present)).to.equal(false);
		expect(isGenuineNodeDeletion('put', absent)).to.equal(false);
	});

	it('does NOT treat a patch with no decodable value as a deletion', () => {
		expect(isGenuineNodeDeletion('patch', present)).to.equal(false);
		expect(isGenuineNodeDeletion('patch', absent)).to.equal(false);
	});

	it('only consults storage for delete events (puts/patches short-circuit)', () => {
		let calls = 0;
		const probe = () => {
			calls++;
			return false;
		};
		isGenuineNodeDeletion('put', probe);
		isGenuineNodeDeletion('patch', probe);
		expect(calls).to.equal(0);
		isGenuineNodeDeletion('delete', probe);
		expect(calls).to.equal(1);
	});
});
