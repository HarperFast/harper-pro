import { join } from 'node:path';
import {
	getCertTable,
	getPrivateKeys,
	getCertAuthority,
	generateSerialNumber,
	createTLSSelector,
	certExtensions,
	CERT_ATTRIBUTES,
	getCommonName,
} from '../core/security/keys.js';
import env from '../core/utility/environment/environmentManager.js';
import { LICENSE_KEY_DIR_NAME } from '../core/utility/hdbTerms.ts';
import { existsSync, readFileSync } from 'node:fs';
import forge from 'node-forge';
import harperLogger from '../core/utility/logging/harper_logger.js';
import { X509Certificate } from 'node:crypto';
import { getThisNodeName } from '../core/server/nodeName.ts';
const { forComponent } = harperLogger;
const logger = forComponent('certificate').conditional;
const pki = forge.pki;
const CERT_VALIDITY_DAYS = 3650;

export async function signCertificate(req) {
	const response = {};
	const hdbKeysDir = join(env.getHdbBasePath(), LICENSE_KEY_DIR_NAME);

	if (req.csr) {
		let private_key;
		let cert_auth;
		const certificateTable = getCertTable();
		const privateKeys = getPrivateKeys();
		// Search hdbCertificate for a non-HDB CA that also has a local private key
		for await (const cert of certificateTable.search([])) {
			if (cert.is_authority && !cert.details.issuer.includes('HarperDB-Certificate-Authority')) {
				if (privateKeys.has(cert.private_key_name)) {
					private_key = privateKeys.get(cert.private_key_name);
					cert_auth = cert;
					break;
				} else if (cert.private_key_name && existsSync(join(hdbKeysDir, cert.private_key_name))) {
					private_key = readFileSync(join(hdbKeysDir, cert.private_key_name));
					cert_auth = cert;
					break;
				}
			}
		}

		// If the search above did not find a CA look for a CA with a matching private key
		if (!private_key) {
			const certAndKey = await getCertAuthority();
			cert_auth = certAndKey.ca;
			private_key = certAndKey.private_key;
		}

		private_key = pki.privateKeyFromPem(private_key);
		response.signingCA = cert_auth.certificate;
		const caAppCert = pki.certificateFromPem(cert_auth.certificate);
		logger.info?.('Signing CSR with cert named', cert_auth.name);
		const csr = pki.certificationRequestFromPem(req.csr);
		try {
			csr.verify();
		} catch (err) {
			logger.error?.(err);
			return new Error(`Error verifying CSR: ` + err.message);
		}

		const cert = forge.pki.createCertificate();
		cert.serialNumber = generateSerialNumber();
		cert.validity.notBefore = new Date();
		const notAfter = new Date();
		cert.validity.notAfter = notAfter;
		cert.validity.notAfter.setDate(notAfter.getDate() + CERT_VALIDITY_DAYS);
		logger.info?.('sign cert setting validity:', cert.validity);

		// subject from CSR
		logger.info?.('sign cert setting subject from CSR:', csr.subject.attributes);
		cert.setSubject(csr.subject.attributes);

		// issuer from CA
		logger.info?.('sign cert setting issuer:', caAppCert.subject.attributes);
		cert.setIssuer(caAppCert.subject.attributes);

		const extensions = csr.getAttribute({ name: 'extensionRequest' }).extensions;
		logger.info?.('sign cert adding extensions from CSR:', extensions);
		cert.setExtensions(extensions);

		cert.publicKey = csr.publicKey;
		cert.sign(private_key, forge.md.sha256.create());

		response.certificate = pki.certificateToPem(cert);
	} else {
		logger.info?.('Sign cert did not receive a CSR from:', req.url, 'only the CA will be returned');
	}

	return response;
}
export async function createCsr() {
	const rep = await getReplicationCert();
	const opsCert = pki.certificateFromPem(rep.options.cert);
	const opsPrivateKey = pki.privateKeyFromPem(rep.options.key);

	logger.info?.('Creating CSR with cert named:', rep.name);

	const csr = pki.createCertificationRequest();
	csr.publicKey = opsCert.publicKey;
	const subject = [
		{
			name: 'commonName',
			value: getCommonName(),
		},
		...CERT_ATTRIBUTES,
	];
	logger.info?.('Creating CSR with subject', subject);
	csr.setSubject(subject);

	const attributes = [
		{
			name: 'unstructuredName',
			value: 'HarperDB, Inc.',
		},
		{
			name: 'extensionRequest',
			extensions: certExtensions(),
		},
	];
	logger.info?.('Creating CSR with attributes', attributes);
	csr.setAttributes(attributes);

	csr.sign(opsPrivateKey);

	return forge.pki.certificationRequestToPem(csr);
}

export async function getReplicationCert() {
	const SNICallback = createTLSSelector('operations-api');
	const secureTarget = {
		secureContexts: null,
		setSecureContext: (ctx) => {},
	};
	await SNICallback.initialize(secureTarget);
	const cert = secureTarget.secureContexts.get(getThisNodeName());
	if (!cert) return;
	const certParsed = new X509Certificate(cert.options.cert);
	cert.cert_parsed = certParsed;
	cert.issuer = certParsed.issuer;

	return cert;
}

export async function getReplicationCertAuth() {
	getCertTable();
	const certPem = (await getReplicationCert()).options.cert;
	const repCert = new X509Certificate(certPem);
	const caName = repCert.issuer.match(/CN=(.*)/)?.[1];
	return getCertTable().get(caName);
}
