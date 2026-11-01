import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import mkcert from 'mkcert';
import sinon from 'sinon';
import * as proCertificate from '#src/security/certificate';
import * as coreKeys from '#src/core/security/keys';
import { setNode, addNodeBack } from '#src/replication/setNode';
import { getHDBNodeTable } from '#src/replication/knownNodes';
import { databases, getDatabases, table } from '#src/core/resources/databases';
import { contextStorage } from '#src/core/resources/transaction';
import { isJoinableScope } from '#src/core/resources/DatabaseTransaction';
import { hasRecordProvenance, isCurrentUser, trackUserRecords } from '#src/core/security/user';
import { getThisNodeName } from '#src/core/server/nodeName';
import {
	get as getEnv,
	getHdbBasePath,
	setHdbBasePath,
	setProperty,
} from '#src/core/utility/environment/environmentManager';
import { CONFIG_PARAMS } from '#src/core/utility/hdbTerms';

function withTimeout(promise, ms, label) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

describe('getReplicationCert and getReplicationCertAuth (Pro security/certificate)', function () {
	this.timeout(20_000);

	const sandbox = sinon.createSandbox();
	const keyName = `rep-test-key-${process.pid}-${Date.now()}.pem`;
	const otherKeyName = `rep-other-key-${process.pid}-${Date.now()}.pem`;
	let certTable;
	let savedCerts = [];
	let previousBasePath;
	let previousReplicationUrl;
	let nodeName;
	let ca;
	let caName;
	let nodeCert;
	let otherCert;

	before(async () => {
		previousBasePath = getHdbBasePath();
		setHdbBasePath(process.env.STORAGE_PATH);

		certTable = coreKeys.getCertTable();
		databases.system ??= {};
		databases.system.hdb_certificate ??= certTable;
		if (!getDatabases().system?.hdb_user) {
			table({
				table: 'hdb_user',
				database: 'system',
				attributes: [{ name: 'username', isPrimaryKey: true }],
			});
		}

		savedCerts = [];
		for await (const cert of certTable.search([])) {
			savedCerts.push({ ...cert });
		}
		await certTable.clear();

		previousReplicationUrl = getEnv(CONFIG_PARAMS.REPLICATION_URL);
		setProperty(CONFIG_PARAMS.REPLICATION_URL, 'wss://127.0.0.1:9933');
		nodeName = getThisNodeName();

		const uniqueOrg = `Harper-RepCert-Test-${Date.now()}`;
		ca = await mkcert.createCA({
			organization: `${uniqueOrg}-CA`,
			countryCode: 'US',
			state: 'CO',
			locality: 'Denver',
			validity: 1,
		});
		caName = new X509Certificate(ca.cert).subject.match(/CN=(.*)/)?.[1];
		assert.ok(caName, 'expected test CA certificate to have a CN');

		nodeCert = await mkcert.createCert({
			domains: [nodeName, '127.0.0.1', 'localhost'],
			validityDays: 1,
			ca,
		});
		otherCert = await mkcert.createCert({
			domains: ['unrelated-peer.harper.test'],
			validityDays: 1,
			ca,
		});
	});

	afterEach(async () => {
		sandbox.restore();
		coreKeys.getPrivateKeys().delete(keyName);
		coreKeys.getPrivateKeys().delete(otherKeyName);
		await certTable?.clear();
	});

	after(async () => {
		sandbox.restore();
		coreKeys.getPrivateKeys().delete(keyName);
		coreKeys.getPrivateKeys().delete(otherKeyName);
		if (previousReplicationUrl !== undefined) {
			setProperty(CONFIG_PARAMS.REPLICATION_URL, previousReplicationUrl);
		}
		if (previousBasePath !== undefined) {
			setHdbBasePath(previousBasePath);
		}
		if (certTable) {
			await certTable.clear();
			for (const cert of savedCerts) {
				await certTable.put(cert);
			}
		}
	});

	it('re-exports the canonical getReplicationCert and getReplicationCertAuth functions from core/security/keys', () => {
		assert.strictEqual(proCertificate.getReplicationCert, coreKeys.getReplicationCert);
		assert.strictEqual(proCertificate.getReplicationCertAuth, coreKeys.getReplicationCertAuth);
	});

	it('does not subscribe to hdb_certificate or leave an open transaction on an ambient context with a stale user', async () => {
		coreKeys.getPrivateKeys().set(keyName, nodeCert.key);
		await coreKeys.setCertTable({
			name: nodeName,
			uses: ['replication'],
			certificate: nodeCert.cert,
			private_key_name: keyName,
			is_authority: false,
			is_self_signed: false,
		});
		await coreKeys.setCertTable({
			name: caName,
			uses: [],
			certificate: ca.cert,
			is_authority: true,
			is_self_signed: true,
		});

		const subscribeSpy = sandbox.spy(databases.system.hdb_certificate, 'subscribe');

		// Stale provenance forces registerLiveSubscriptionForContext's verify() branch.
		const staleUser = { username: 'stale-replication-admin', active: true };
		trackUserRecords(staleUser, {
			username: 'stale-replication-admin',
			userStamp: -1,
			roleId: undefined,
			roleStamp: null,
		});
		assert.equal(hasRecordProvenance(staleUser), true);
		assert.equal(isCurrentUser(staleUser), false);

		const nodeTable = getHDBNodeTable();
		const ambientStore = { user: staleUser };
		try {
			await contextStorage.run(ambientStore, async () => {
				const cert = await proCertificate.getReplicationCert();
				assert.equal(
					isJoinableScope(ambientStore.transaction),
					false,
					'getReplicationCert must not leave an open joinable transaction on the ambient context'
				);
				assert.ok(cert, 'expected getReplicationCert to return the node replication certificate');
				assert.equal(cert.name, nodeName);

				const caRecord = await proCertificate.getReplicationCertAuth();
				assert.equal(
					isJoinableScope(ambientStore.transaction),
					false,
					'getReplicationCertAuth must not leave an open joinable transaction on the ambient context'
				);
				assert.ok(caRecord, 'expected getReplicationCertAuth to return the issuing CA record');
				assert.equal(caRecord.name, caName);

				const res = await addNodeBack({
					hostname: 'peer-wss-node',
					url: 'wss://127.0.0.1:9997',
				});
				assert.equal(
					isJoinableScope(ambientStore.transaction),
					false,
					'addNodeBack must not leave an open joinable transaction on the ambient context'
				);
				assert.equal(res.usingCA, ca.cert);
			});
		} finally {
			await nodeTable.delete('peer-wss-node');
			await nodeTable.delete(nodeName);
		}

		assert.equal(subscribeSpy.callCount, 0, 'one-shot replication cert lookup must not subscribe to hdb_certificate');
	});

	// A non-owner read opens the HTTP worker's first replication connection, so an anonymous request can be what
	// initializes the replication TLS selector.
	it('builds the replication TLS selector when an anonymous request initializes it', async () => {
		coreKeys.getPrivateKeys().set(keyName, nodeCert.key);
		await coreKeys.setCertTable({
			name: nodeName,
			uses: ['replication'],
			certificate: nodeCert.cert,
			private_key_name: keyName,
			is_authority: false,
			is_self_signed: false,
		});
		const anonymousRequest = { authorize: true, user: undefined };
		const target = { secureContexts: null, secureContextsListeners: [] };
		// live reload: its certificate-table subscription is what nests a run() inside the selector's exit()
		const subscribeSpy = sandbox.spy(databases.system.hdb_certificate, 'subscribe');
		const selector = coreKeys.createTLSSelector('replication');
		try {
			await withTimeout(
				contextStorage.run(anonymousRequest, () => selector.initialize(target)),
				10_000,
				'replication TLS selector initialization'
			);
			assert.ok(target.secureContexts.has(nodeName), 'the selector must read the certificate table as the system');
			assert.equal(anonymousRequest.authorize, true, "the request's authorization gate is left for the request");
		} finally {
			for (const subscription of subscribeSpy.returnValues) {
				await subscription.then((opened) => opened?.end?.()).catch(() => {});
			}
		}
	});

	for (const scenario of [
		{
			label: 'when hdb_certificate has no certificates',
			setup: async () => {},
		},
		{
			label: 'when hdb_certificate has no certificate matching this node name',
			setup: async () => {
				coreKeys.getPrivateKeys().set(otherKeyName, otherCert.key);
				await coreKeys.setCertTable({
					name: 'unrelated-peer.harper.test',
					uses: ['replication'],
					certificate: otherCert.cert,
					private_key_name: otherKeyName,
					is_authority: false,
					is_self_signed: false,
				});
			},
		},
	]) {
		it(`fails fast with a clear error instead of hanging or throwing TypeError ${scenario.label}`, async () => {
			await scenario.setup();

			const rep = await withTimeout(proCertificate.getReplicationCert(), 2000, 'getReplicationCert');
			assert.equal(rep, undefined);

			await assert.rejects(
				withTimeout(proCertificate.createCsr(), 2000, 'createCsr'),
				/Unable to find a certificate to use for replication/
			);

			await assert.rejects(
				withTimeout(
					setNode({ operation: 'add_node', name: 'peer-node', url: 'wss://127.0.0.1:9999' }),
					2000,
					'setNode'
				),
				/Unable to find a certificate to use for replication/
			);

			await assert.rejects(
				withTimeout(addNodeBack({ hostname: 'peer-node', url: 'wss://127.0.0.1:9999' }), 2000, 'addNodeBack'),
				/Unable to find a certificate to use for replication/
			);
		});
	}

	it('allows addNodeBack for a plaintext ws:// peer without a CSR when hdb_certificate is empty', async () => {
		const nodeTable = getHDBNodeTable();
		await nodeTable.put(nodeName, {
			name: nodeName,
			url: 'wss://127.0.0.1:9933',
			ca: ca.cert,
			replicates: true,
			subscriptions: null,
		});
		try {
			const res = await withTimeout(
				addNodeBack({ hostname: 'peer-ws-node', url: 'ws://127.0.0.1:9998' }),
				2000,
				'addNodeBack ws://'
			);
			assert.equal(res.nodeName, nodeName);
			assert.equal(res.usingCA, undefined);
			const selfRow = await nodeTable.get(nodeName);
			assert.equal(selfRow?.ca, ca.cert);
		} finally {
			await nodeTable.delete('peer-ws-node');
			await nodeTable.delete(nodeName);
		}
	});

	it('preserves usingCA and this node ca in hdb_nodes on a ws:// addNodeBack when a replication cert exists', async () => {
		coreKeys.getPrivateKeys().set(keyName, nodeCert.key);
		await coreKeys.setCertTable({
			name: nodeName,
			uses: ['replication'],
			certificate: nodeCert.cert,
			private_key_name: keyName,
			is_authority: false,
			is_self_signed: false,
		});
		await coreKeys.setCertTable({
			name: caName,
			uses: [],
			certificate: ca.cert,
			is_authority: true,
			is_self_signed: true,
		});

		const nodeTable = getHDBNodeTable();
		try {
			const res = await withTimeout(
				addNodeBack({ hostname: 'peer-ws-node', url: 'ws://127.0.0.1:9998' }),
				2000,
				'addNodeBack ws:// with cert'
			);
			assert.equal(res.nodeName, nodeName);
			assert.equal(res.usingCA, ca.cert);
			const selfRow = await nodeTable.get(nodeName);
			assert.equal(selfRow?.ca, ca.cert);
		} finally {
			await nodeTable.delete('peer-ws-node');
			await nodeTable.delete(nodeName);
		}
	});
});
