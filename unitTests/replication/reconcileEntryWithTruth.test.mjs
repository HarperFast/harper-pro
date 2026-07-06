/**
 * Coverage for `reconcileEntryWithTruth` — the W1 (harper-pro#431) rule set for correcting the main
 * thread's edge-triggered `connected` bit from the shared-memory truth the owning worker writes. The
 * rules these tests pin: no correction without truth or without at-least-once liveness; a down
 * correction flips true/undefined entries to false and stamps disconnectedAt only if absent (so the
 * wedge re-drive clock is not restarted by repeated ticks); an up correction applies ONLY to an
 * explicit connected:false entry (a lost connect edge, #289) — never to a never-connected undefined
 * entry, which is mid-connect and owned by the connect/retry path; agreement in either direction is a
 * no-op returning undefined.
 */

import { expect } from 'chai';
import { reconcileEntryWithTruth } from '#src/replication/subscriptionManager';

const NOW = 1_000_000;
const up = { connected: true, state: 2, lastLiveness: NOW - 1000 };
const down = { connected: false, state: 0, lastLiveness: NOW - 1000, errorCode: 1006 };

describe('reconcileEntryWithTruth', () => {
	it('does nothing without truth', () => {
		const entry = { connected: true };
		expect(reconcileEntryWithTruth(entry, undefined, NOW)).to.equal(undefined);
		expect(entry.connected).to.equal(true);
	});

	it('does nothing when the buffer has never reported liveness', () => {
		const entry = { connected: true };
		expect(reconcileEntryWithTruth(entry, { ...down, lastLiveness: 0 }, NOW)).to.equal(undefined);
		expect(entry.connected).to.equal(true);
	});

	it('corrects a connected:true entry down and stamps disconnectedAt', () => {
		const entry = { connected: true };
		expect(reconcileEntryWithTruth(entry, down, NOW)).to.equal('down');
		expect(entry.connected).to.equal(false);
		expect(entry.disconnectedAt).to.equal(NOW);
	});

	it('corrects a never-connected (undefined) entry down', () => {
		const entry = {};
		expect(reconcileEntryWithTruth(entry, down, NOW)).to.equal('down');
		expect(entry.connected).to.equal(false);
		expect(entry.disconnectedAt).to.equal(NOW);
	});

	it('preserves an existing disconnectedAt on a down correction (does not restart the wedge clock)', () => {
		const entry = { connected: true, disconnectedAt: NOW - 60_000 };
		expect(reconcileEntryWithTruth(entry, down, NOW)).to.equal('down');
		expect(entry.disconnectedAt).to.equal(NOW - 60_000);
	});

	it('corrects a connected:false entry up and clears disconnectedAt', () => {
		const entry = { connected: false, disconnectedAt: NOW - 60_000 };
		expect(reconcileEntryWithTruth(entry, up, NOW)).to.equal('up');
		expect(entry.connected).to.equal(true);
		expect(entry.disconnectedAt).to.equal(undefined);
	});

	it('does NOT up-correct a never-connected (undefined) entry', () => {
		const entry = { createdAt: NOW - 60_000 };
		expect(reconcileEntryWithTruth(entry, up, NOW)).to.equal(undefined);
		expect(entry.connected).to.equal(undefined);
	});

	it('is a no-op on agreement in both directions', () => {
		const connectedEntry = { connected: true };
		expect(reconcileEntryWithTruth(connectedEntry, up, NOW)).to.equal(undefined);
		expect(connectedEntry.connected).to.equal(true);

		const downEntry = { connected: false, disconnectedAt: NOW - 5000 };
		expect(reconcileEntryWithTruth(downEntry, down, NOW)).to.equal(undefined);
		expect(downEntry.connected).to.equal(false);
		expect(downEntry.disconnectedAt).to.equal(NOW - 5000);
	});
});
