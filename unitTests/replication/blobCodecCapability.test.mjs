/**
 * Coverage for the stored-blob-codec capability helpers behind replication codec preservation
 * (harper#2443): what this node advertises in the NODE_NAME capabilities object, and how a peer's
 * advertisement is parsed. The advertisement is the entire negotiation — a sender streams a stored
 * deflate body only to a peer whose parsed set contains 'deflate' — so the parse must be strict
 * about shape (an old peer sends no capabilities object at all; a malformed one must read as
 * "accepts nothing", never as acceptance).
 */
import { expect } from 'chai';
import { acceptedBlobCodecs, parseAcceptedBlobCodecs } from '#src/replication/replicationConnection';

describe('acceptedBlobCodecs (advertisement + kill switch)', () => {
	it('advertises deflate by default', () => {
		expect(acceptedBlobCodecs({})).to.deep.equal(['deflate']);
	});

	it('the env kill switch stops the advertisement', () => {
		for (const value of ['0', 'false', 'none', '', ' FALSE ']) {
			expect(acceptedBlobCodecs({ HARPER_REPLICATION_ACCEPT_BLOB_CODECS: value })).to.deep.equal(
				[],
				`value ${JSON.stringify(value)} must disable`
			);
		}
	});

	it('an unrecognized value keeps the default advertisement', () => {
		expect(acceptedBlobCodecs({ HARPER_REPLICATION_ACCEPT_BLOB_CODECS: '1' })).to.deep.equal(['deflate']);
	});
});

describe('parseAcceptedBlobCodecs (peer advertisement)', () => {
	it('parses a well-formed advertisement', () => {
		expect(parseAcceptedBlobCodecs({ acceptBlobCodecs: ['deflate'] }).has('deflate')).to.equal(true);
	});

	it('an old peer (no capabilities object) accepts nothing', () => {
		expect(parseAcceptedBlobCodecs(undefined).size).to.equal(0);
		expect(parseAcceptedBlobCodecs(null).size).to.equal(0);
		expect(parseAcceptedBlobCodecs({}).size).to.equal(0);
	});

	it('malformed advertisements read as accepting nothing, never as acceptance', () => {
		expect(parseAcceptedBlobCodecs({ acceptBlobCodecs: 'deflate' }).size).to.equal(0);
		expect(parseAcceptedBlobCodecs({ acceptBlobCodecs: { deflate: true } }).size).to.equal(0);
		expect(parseAcceptedBlobCodecs({ acceptBlobCodecs: [42, null, {}] }).size).to.equal(0);
	});

	it('non-string entries are dropped while string entries survive', () => {
		const parsed = parseAcceptedBlobCodecs({ acceptBlobCodecs: [42, 'deflate', null] });
		expect([...parsed]).to.deep.equal(['deflate']);
	});
});
