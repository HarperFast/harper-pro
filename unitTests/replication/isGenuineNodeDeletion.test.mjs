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
 * The ambiguity only applies to put/patch events: a null value on a put/patch means the
 * record failed to decode. A `delete` event from the change stream is the reliable signal
 * that a record is truly gone — trusting it unconditionally is correct and necessary so that
 * genuine remove_node deletes are not suppressed (regression fix).
 */

import { expect } from 'chai';
import { isGenuineNodeDeletion } from '#src/replication/knownNodes';

describe('isGenuineNodeDeletion', () => {
	it('treats a delete event as a genuine deletion regardless of physical storage state', () => {
		// Both absent and present storage states: a delete event is always genuine.
		expect(isGenuineNodeDeletion('delete')).to.equal(true);
	});

	it('does NOT treat a put with no decodable value as a deletion', () => {
		// A put always carries a value; a nullish value means it failed to decode.
		expect(isGenuineNodeDeletion('put')).to.equal(false);
	});

	it('does NOT treat a patch with no decodable value as a deletion', () => {
		expect(isGenuineNodeDeletion('patch')).to.equal(false);
	});
});
