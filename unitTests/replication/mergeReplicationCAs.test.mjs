/**
 * Coverage for the replicated-operation TLS trust fix. Replicated operations
 * (replicateOperation → sendOperationToNode) open a transient connection outside the subscription
 * context where `replicationCertificateAuthorities` is kept populated by monitorNodeCAs, so that set
 * may not yet contain the target peer's CA. mergeReplicationCAs lets the operation path add the peer's
 * specific CA (its hdb_nodes.ca) so a node whose replication cert is signed by a CA absent from the
 * local static cert store is still trusted — matching how the subscription path trusts each node's CA.
 */

import { expect } from 'chai';
import { mergeReplicationCAs } from '#src/replication/replicationConnection';
import { replicationCertificateAuthorities } from '#src/replication/replicator';

describe('mergeReplicationCAs — replicated-operation per-node CA trust', () => {
	const REPL_CA = '-----BEGIN CERTIFICATE-----\nREPLICATION_SET_CA\n-----END CERTIFICATE-----';
	const STATIC_CA = '-----BEGIN CERTIFICATE-----\nSECURE_CONTEXT_CA\n-----END CERTIFICATE-----';
	const NODE_CA = '-----BEGIN CERTIFICATE-----\nPEER_SPECIFIC_CA\n-----END CERTIFICATE-----';

	beforeEach(() => replicationCertificateAuthorities.add(REPL_CA));
	afterEach(() => replicationCertificateAuthorities.delete(REPL_CA));

	it('combines the replication CA set with the secure context CAs', () => {
		const result = mergeReplicationCAs([STATIC_CA]);
		expect(result).to.include(REPL_CA);
		expect(result).to.include(STATIC_CA);
	});

	it('omits any per-node CA when none is supplied', () => {
		const result = mergeReplicationCAs([STATIC_CA]);
		expect(result).to.not.include(NODE_CA);
	});

	it("adds the peer's specific CA when nodeCA is supplied (the operation-path fix)", () => {
		const result = mergeReplicationCAs([STATIC_CA], NODE_CA);
		expect(result).to.include(REPL_CA);
		expect(result).to.include(STATIC_CA);
		expect(result).to.include(NODE_CA);
	});

	it('does not mutate the shared replication CA set', () => {
		const sizeBefore = replicationCertificateAuthorities.size;
		mergeReplicationCAs([STATIC_CA], NODE_CA);
		expect(replicationCertificateAuthorities.size).to.equal(sizeBefore);
	});
});
