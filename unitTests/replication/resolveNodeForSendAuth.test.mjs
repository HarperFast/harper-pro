/**
 * Coverage for resolveNodeForSendAuth — the record the dynamic send-authorization watch in
 * replicationConnection.ts evaluates for each hdb_nodes change event.
 *
 * Background: that watch used to read `event.value` directly and close the connection with
 * `1008 Unauthorized database subscription` whenever the value did not carry `replicates`. Several
 * event shapes carry no value for a peer that is replicating normally — most damagingly the
 * whole-table `reload` marker a copyApply base copy of hdb_nodes emits, which transactionBroadcast
 * fans out to EVERY subscriber on the table with a null id and no value. Every node cloning or
 * joining base-copies the system database, so the marker tore the whole mesh down mid-formation
 * (both directions closed ~1ms after the marker landed) and left the cluster to race a reconnect.
 *
 * The rule this pins: a clean tombstone de-authorizes; a valid row is evaluated; anything undecodable
 * defers the verdict to the caller (which re-probes for a bounded grace period, then fails closed).
 * A genuine `delete` event never reaches this helper — the caller short-circuits it via
 * isGenuineNodeDeletion, since a point read can be served from a snapshot predating the delete commit
 * (harper#1163).
 */

import { expect } from 'chai';
import { resolveNodeForSendAuth, isGenuineNodeDeletion, SEND_AUTH_UNCHANGED } from '#src/replication/knownNodes';

const deleted = () => ({ outcome: 'deleted' });
const present = (record) => () => ({ outcome: 'decode-failure', record });

describe('resolveNodeForSendAuth', () => {
	it('returns the authoritative record when the row is present and valid', () => {
		const record = { name: 'node-a', replicates: true };
		expect(resolveNodeForSendAuth('node-a', present(record))).to.equal(record);
	});

	it('returns the record even when it de-authorizes, so the caller can close', () => {
		const record = { name: 'node-a', replicates: false };
		expect(resolveNodeForSendAuth('node-a', present(record))).to.equal(record);
	});

	it('returns undefined for a genuine remove_node tombstone', () => {
		expect(resolveNodeForSendAuth('node-a', deleted)).to.equal(undefined);
	});

	it('leaves the connection alone when the row is present but undecodable', () => {
		expect(resolveNodeForSendAuth('node-a', present(undefined))).to.equal(SEND_AUTH_UNCHANGED);
	});

	it('leaves the connection alone for the [] misread (harper-pro#345)', () => {
		expect(resolveNodeForSendAuth('node-a', present([]))).to.equal(SEND_AUTH_UNCHANGED);
	});

	it('ignores the event payload entirely — a reload marker re-reads the live row', () => {
		// The reload marker itself carries { id: null, value: undefined }; the peer is still
		// replicating, so the row read must be what decides.
		const record = { name: 'node-a', replicates: true };
		expect(resolveNodeForSendAuth('node-a', present(record))).to.equal(record);
	});

	it("a stale-snapshot read on a delete is not this helper's call — isGenuineNodeDeletion decides", () => {
		// The store can still serve the authorizing row from a snapshot predating the delete commit
		// (harper#1163), which is exactly why the caller must not route a delete event through here.
		expect(isGenuineNodeDeletion('delete')).to.equal(true);
		expect(isGenuineNodeDeletion('reload')).to.equal(false);
		expect(isGenuineNodeDeletion('put')).to.equal(false);
		expect(isGenuineNodeDeletion('patch')).to.equal(false);
	});

	it('probes the record by name', () => {
		const probed = [];
		resolveNodeForSendAuth('node-b', (key) => {
			probed.push(key);
			return { outcome: 'decode-failure', record: { name: 'node-b', replicates: true } };
		});
		expect(probed).to.deep.equal(['node-b']);
	});
});
