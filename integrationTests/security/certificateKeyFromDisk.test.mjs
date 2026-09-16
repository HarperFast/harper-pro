/**
 * harper-pro#858: add_certificate must resolve a private key that is on disk but absent from the
 * in-memory privateKeys map, which holds config-referenced keys only. The restart is what makes
 * the miss real — after it, a key added through add_certificate is on disk and named by its
 * certificate record, but nothing put it back in the map.
 */
import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert';
import { join } from 'node:path';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { createCA, createCert } from 'mkcert';
import forge from 'node-forge';
import { startHarper, killHarper, teardownHarper } from '@harperfast/integration-testing';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

const OWNER_CERT_NAME = 'disk-key-owner';
const OWNER_KEY_FILE = `${OWNER_CERT_NAME}.pem`;

async function sendOperation(node, operation) {
	const response = await fetch(node.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(operation),
	});
	return { status: response.status, body: await response.json() };
}

async function sendOperationOk(node, operation) {
	const { status, body } = await sendOperation(node, operation);
	equal(status, 200, JSON.stringify(body));
	return body;
}

// A new certificate for a key the node already holds — the shape create_csr + sign_certificate
// produces, and the shape #858 was reported against.
function reissueCertificate(privateKeyPem, commonName) {
	const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
	const cert = forge.pki.createCertificate();
	cert.publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);
	cert.serialNumber = '02';
	cert.validity.notBefore = new Date();
	cert.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);
	const attributes = [{ name: 'commonName', value: commonName }];
	cert.setSubject(attributes);
	cert.setIssuer(attributes);
	cert.sign(privateKey, forge.md.sha256.create());
	return forge.pki.certificateToPem(cert);
}

suite('Certificate key resolved from disk', (ctx) => {
	let testCA;
	let ownerCertificate;
	let unmatchedCertificate;
	let keysDir;

	before(async () => {
		await startHarper(ctx);
		keysDir = join(ctx.harper.dataRootDir, 'keys');

		testCA = await createCA({
			organization: 'Unit Test CA',
			countryCode: 'USA',
			state: 'Colorado',
			locality: 'Denver',
			validity: 1,
		});
		const certOptions = { ca: { key: testCA.key, cert: testCA.cert }, validityDays: 1 };
		ownerCertificate = await createCert({ ...certOptions, domains: ['disk-key-owner.test'] });
		unmatchedCertificate = await createCert({ ...certOptions, domains: ['no-such-key.test'] });
		const brokenCertificate = await createCert({ ...certOptions, domains: ['broken-key.test'] });
		const missingCertificate = await createCert({ ...certOptions, domains: ['missing-key.test'] });

		// The key this suite resolves from disk after the restart.
		await sendOperationOk(ctx.harper, {
			operation: 'add_certificate',
			name: OWNER_CERT_NAME,
			certificate: ownerCertificate.cert,
			private_key: ownerCertificate.key,
			is_authority: false,
		});

		// Two candidates that must not abort the search: one whose key file is not a parseable key,
		// one whose key file is gone.
		await sendOperationOk(ctx.harper, {
			operation: 'add_certificate',
			name: 'broken-key-holder',
			certificate: brokenCertificate.cert,
			private_key: 'not a private key',
			is_authority: false,
		});
		await sendOperationOk(ctx.harper, {
			operation: 'add_certificate',
			name: 'missing-key-holder',
			certificate: missingCertificate.cert,
			private_key: missingCertificate.key,
			is_authority: false,
		});
		rmSync(join(keysDir, 'missing-key-holder.pem'));
		writeFileSync(join(keysDir, 'not-a-key.txt'), 'stray file in the keys directory\n');

		ok(existsSync(join(keysDir, OWNER_KEY_FILE)), `${OWNER_KEY_FILE} should have been written to disk`);

		// Restart on the same data dir: the privateKeys map is rebuilt from config-referenced paths
		// only, so the keys added above are on disk and named by certificate records but no longer
		// in the map.
		await killHarper(ctx);
		await startHarper(ctx);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('add_certificate resolves a matching private key from the keys directory', async () => {
		const reissued = reissueCertificate(ownerCertificate.key, 'reissued-from-disk-key');
		const addResponse = await sendOperationOk(ctx.harper, {
			operation: 'add_certificate',
			name: 'reissued-from-disk-key',
			certificate: reissued,
			is_authority: false,
		});
		equal(addResponse.message, 'Successfully added certificate: reissued-from-disk-key');

		const certificates = await sendOperationOk(ctx.harper, { operation: 'list_certificates' });
		const added = certificates.find((certificate) => certificate.name === 'reissued-from-disk-key');
		ok(added, 'the reissued certificate should be in the table');
		equal(added.private_key_name, OWNER_KEY_FILE);
		ok(existsSync(join(keysDir, added.private_key_name)), 'private_key_name should resolve to a file on disk');
	});

	test('add_certificate still rejects a certificate with no matching key anywhere', async () => {
		const { status, body } = await sendOperation(ctx.harper, {
			operation: 'add_certificate',
			name: 'no-matching-key',
			certificate: unmatchedCertificate.cert,
			is_authority: false,
		});
		equal(status, 400, JSON.stringify(body));
		equal(body.error, 'A suitable private key was not found for this certificate');

		const certificates = await sendOperationOk(ctx.harper, { operation: 'list_certificates' });
		equal(
			certificates.some((certificate) => certificate.name === 'no-matching-key'),
			false
		);
	});

	test('remove_certificate leaves a key resolved from disk in place', async () => {
		await sendOperationOk(ctx.harper, { operation: 'remove_certificate', name: 'reissued-from-disk-key' });
		ok(existsSync(join(keysDir, OWNER_KEY_FILE)), 'the key the owning certificate still references must survive');
	});
});
