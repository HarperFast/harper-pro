import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert';
import { join } from 'node:path';
import { createCA, createCert } from 'mkcert';
import forge from 'node-forge';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(
	import.meta.dirname ?? module.path,
	'..',
	'..',
	'dist',
	'bin',
	'harper.js'
);

async function sendOperation(node, operation) {
	const response = await fetch(node.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(operation),
	});
	const responseData = await response.json();
	equal(response.status, 200, JSON.stringify(responseData));
	return responseData;
}

suite('Certificate', (ctx) => {
	let testCA;
	let testCertificate;

	before(async () => {
		await startHarper(ctx);
		testCA = await createCA({
			organization: 'Unit Test CA',
			countryCode: 'USA',
			state: 'Colorado',
			locality: 'Denver',
			validity: 1,
		});

		testCertificate = await createCert({
			ca: { key: testCA.key, cert: testCA.cert },
			domains: ['Unit Test', '127.0.0.1', 'localhost', '::1'],
			validityDays: 1,
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('add_certificate and list_certificate certificates successfully', async () => {
		const addResponse = await sendOperation(ctx.harper, {
			operation: 'add_certificate',
			name: 'test-cert',
			certificate: testCertificate.cert,
			private_key: testCertificate.key,
			is_authority: false,
		});
		equal(addResponse.message, 'Successfully added certificate: test-cert');

		const listResponse = await sendOperation(ctx.harper, {
			operation: 'list_certificates',
		});
		equal(listResponse.length > 0, true, 'There should be at least one certificate in the list');
		equal(
			listResponse.some((c) => c.name === 'test-cert'),
			true,
			'Added cert should appear in list'
		);
	});

	test('remove_certificate successfully removes certificate', async () => {
		const addResponse = await sendOperation(ctx.harper, {
			operation: 'add_certificate',
			name: 'test-cert-to-remove',
			certificate: testCertificate.cert,
			private_key: testCertificate.key,
			is_authority: false,
		});
		equal(addResponse.message, 'Successfully added certificate: test-cert-to-remove');

		const removeResponse = await sendOperation(ctx.harper, {
			operation: 'remove_certificate',
			name: 'test-cert-to-remove',
		});
		equal(removeResponse.message, 'Successfully removed test-cert-to-remove');

		const listResponse = await sendOperation(ctx.harper, {
			operation: 'list_certificates',
		});
		equal(
			listResponse.some((c) => c.name === 'test-cert-to-remove'),
			false,
			'Removed cert should not appear in list'
		);
	});

	test('create_csr successfully creates a certificate signing request', async () => {
		const csrResponse = await sendOperation(ctx.harper, {
			operation: 'create_csr',
		});
		ok(
			csrResponse.pem?.includes('BEGIN CERTIFICATE REQUEST'),
			'Response should include a certificate signing request'
		);
		ok(csrResponse.privateKeyName, 'Response should include the private key name');

		// Parse the CSR - will throw if malformed
		const forgeCsr = forge.pki.certificationRequestFromPem(csrResponse.pem);
		// Verify the self-signature
		ok(forgeCsr.verify(), 'CSR signature should be valid');

		// Inspect subject fields if your CSR sets them
		const cn = forgeCsr.subject.getField('CN')?.value;
		ok(cn !== undefined, 'CSR should have a common name');

		// Check the public key exists and is the right type
		const publicKey = forgeCsr.publicKey;
		ok(publicKey !== undefined, 'CSR should contain a public key');
	});

	test('sign_certificate successfully signs a certificate signing request', async () => {
		const csr = await sendOperation(ctx.harper, {
			operation: 'create_csr',
		});

		const signResponse = await sendOperation(ctx.harper, {
			operation: 'sign_certificate',
			csr: csr.pem,
		});

		ok(signResponse.hasOwnProperty('signingCA'), 'Response should include the signing CA certificate');
		ok(signResponse.hasOwnProperty('certificate'), 'Response should include a signed certificate');
		ok(signResponse.signingCA.includes('BEGIN CERTIFICATE'), 'Response should include the signing CA certificate');
		ok(signResponse.certificate.includes('BEGIN CERTIFICATE'), 'Response should include a signed certificate');

		const forgeCert = forge.pki.certificateFromPem(signResponse.certificate);
		ok(forgeCert !== undefined, 'Should be able to parse signed certificate');

		ok(
			forgeCert.issuer.getField('CN')?.value?.includes('Harper-Certificate-Authority'),
			'Issuer CN should match CA common name'
		);
		equal(forgeCert.issuer.getField('O')?.value, 'HarperDB, Inc.', 'Issuer O should be HarperDB, Inc.');
	});
});
