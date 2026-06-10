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

describe('isGenuineNodeDeletion', () => {
	it('treats a real delete whose record is gone as a genuine deletion', () => {
		expect(isGenuineNodeDeletion('delete', false, absent)).to.equal(true);
	});

	it('does NOT treat a delete event as a deletion while the record is still present (decode failure)', () => {
		// This is the production case: a "delete"-shaped signal for a row that is still on
		// disk but undecodable. Tearing the peer down here is exactly the #1163 blast radius.
		expect(isGenuineNodeDeletion('delete', false, present)).to.equal(false);
	});

	it('does NOT treat a put with no decodable value as a deletion (regardless of storage)', () => {
		// A put always carries a value; a nullish value means it failed to decode.
		expect(isGenuineNodeDeletion('put', false, present)).to.equal(false);
		expect(isGenuineNodeDeletion('put', false, absent)).to.equal(false);
	});

	it('does NOT treat a patch with no decodable value as a deletion', () => {
		expect(isGenuineNodeDeletion('patch', false, present)).to.equal(false);
		expect(isGenuineNodeDeletion('patch', false, absent)).to.equal(false);
	});

	it('never treats an event that carried a usable value as a deletion', () => {
		// hasDecodedValue short-circuits before the storage probe is even consulted.
		let probed = false;
		const probe = () => {
			probed = true;
			return false;
		};
		expect(isGenuineNodeDeletion('delete', true, probe)).to.equal(false);
		expect(isGenuineNodeDeletion('put', true, probe)).to.equal(false);
		expect(probed).to.equal(false);
	});

	it('only consults storage for delete events (puts/patches short-circuit)', () => {
		let calls = 0;
		const probe = () => {
			calls++;
			return false;
		};
		isGenuineNodeDeletion('put', false, probe);
		isGenuineNodeDeletion('patch', false, probe);
		expect(calls).to.equal(0);
		isGenuineNodeDeletion('delete', false, probe);
		expect(calls).to.equal(1);
	});
});
