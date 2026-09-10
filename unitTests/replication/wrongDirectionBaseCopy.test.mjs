/**
 * The gate on withholding a peer's own records from a base copy (harper-pro#737). Each condition bounds
 * which peer, and for how long, data may be withheld from — `isLeader` alone is both sticky and
 * non-unique.
 */

import { expect } from 'chai';
import { shouldWithholdPeerOwnRecords, hostnameFromNodeUrl } from '#src/replication/replicationConnection';

const gate = (overrides) =>
	shouldWithholdPeerOwnRecords({
		cloneSource: 'leader.example',
		peerNames: ['leader.example'],
		peerIsOurLeader: true,
		...overrides,
	});

describe('shouldWithholdPeerOwnRecords (#737)', () => {
	it('withholds from the recorded clone source', () => {
		expect(gate({})).to.equal(true);
	});

	it('matches the clone source against the peer node URL host as well as its name', () => {
		expect(gate({ peerNames: ['some-node-name', 'leader.example'] })).to.equal(true);
	});

	it('copies in full when no clone is in flight', () => {
		expect(gate({ cloneSource: undefined })).to.equal(false);
	});

	it('copies in full for a leader that is not the recorded clone source', () => {
		expect(gate({ peerNames: ['other-leader.example'] })).to.equal(false);
	});

	it('copies in full for the clone source when it is not marked as our leader', () => {
		expect(gate({ peerIsOurLeader: false })).to.equal(false);
	});

	it('copies in full when the peer cannot be named', () => {
		expect(gate({ peerNames: [undefined, undefined] })).to.equal(false);
	});
});

describe('hostnameFromNodeUrl (#737)', () => {
	it('reads the host out of a replication URL', () => {
		expect(hostnameFromNodeUrl('wss://leader.example:9933')).to.equal('leader.example');
	});

	it('is undefined for a missing or unparseable URL', () => {
		expect(hostnameFromNodeUrl(undefined)).to.equal(undefined);
		expect(hostnameFromNodeUrl('not a url')).to.equal(undefined);
	});
});
