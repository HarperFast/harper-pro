/**
 * Coverage for describeIdentityMismatch — the fail-loud guard from harper-pro#351.
 *
 * Background: an in-place v4->v5 upgrade boot could plant `node.hostname: localhost` into the
 * migrated config. getThisNodeName() prefers node.hostname over replication.hostname, so the
 * node identifies as `localhost`, finds no matching self row in system.hdb_nodes, and
 * subscriptionManager silently disables user-database replication (system keeps syncing, so the
 * node looks healthy). This helper turns that previously-silent state into a loud warning.
 */

import { expect } from 'chai';
import { describeIdentityMismatch } from '#src/replication/subscriptionManager';

describe('describeIdentityMismatch (harper-pro#351 fail-loud guard)', () => {
	const peers = [
		{ name: 'node-a', url: 'wss://node-a:9933' },
		{ name: 'node-b', url: 'wss://node-b:9933' },
	];

	it('returns undefined when this node matches a registered peer by name', () => {
		expect(describeIdentityMismatch('node-a', 'wss://node-a:9933', peers)).to.equal(undefined);
	});

	it('returns undefined when this node matches a registered peer by url only', () => {
		// name differs but url matches (e.g. name resolved differently this boot)
		expect(describeIdentityMismatch('different-name', 'wss://node-a:9933', peers)).to.equal(undefined);
	});

	it('returns undefined when hdb_nodes is empty (brand-new / unjoined node)', () => {
		expect(describeIdentityMismatch('localhost', 'wss://localhost:9933', [])).to.equal(undefined);
		expect(describeIdentityMismatch('localhost', 'wss://localhost:9933', undefined)).to.equal(undefined);
	});

	it('warns loudly when there are peers but this node matches none (the #351 case)', () => {
		const msg = describeIdentityMismatch('localhost', 'wss://localhost:9933', peers);
		expect(msg).to.be.a('string');
		expect(msg).to.match(/identity mismatch/i);
		expect(msg).to.contain('localhost');
		// surfaces the registered peers and points the operator at the real fix
		expect(msg).to.contain('node-a');
		expect(msg).to.match(/hdb_nodes/);
		expect(msg).to.match(/harper-pro#351/);
	});

	it('does not match on a falsy name/url collision', () => {
		// a peer with no name must not be treated as a match for an undefined thisName
		const msg = describeIdentityMismatch(undefined, undefined, [{ url: 'wss://node-a:9933' }]);
		expect(msg).to.be.a('string');
		expect(msg).to.match(/identity mismatch/i);
	});
});
