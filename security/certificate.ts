import Joi from 'joi';
import forge from 'node-forge';
import { access, constants, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { validateBySchema } from '../core/validation/validationWrapper.js';
import { ClientError } from '../core/utility/errors/hdbError.js';
import {
    getCertTable,
    getPrivateKeys,
    getCertAuthority,
    generateSerialNumber,
    createTLSSelector,
    certExtensions,
    CERT_ATTRIBUTES,
    getCommonName,
    getPrimaryHostName,
    setCertTable,
} from '../core/security/keys.js';
import env from '../core/utility/environment/environmentManager.js';
import { LICENSE_KEY_DIR_NAME } from '../core/utility/hdbTerms.ts';
import harperLogger from '../core/utility/logging/harper_logger.js';
import { getThisNodeName } from '../core/server/nodeName.ts';
import { server } from '../core/server/Server.ts';
import { replicateOperation } from '../replication/replicator.ts';

const { forComponent } = harperLogger;
const logger = forComponent('certificate').conditional;
const pki = forge.pki;
const CERT_VALIDITY_DAYS = 3650;

const fileExists = async (path: string): Promise<boolean> =>
    access(path, constants.F_OK)
        .then(() => true)
        .catch(() => false);

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
                } else if (cert.private_key_name && (await fileExists(join(hdbKeysDir, cert.private_key_name)))) {
                    private_key = await readFile(join(hdbKeysDir, cert.private_key_name));
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

interface AddCertificateRequest {
    name?: string;
    certificate: string;
    is_authority: boolean;
    private_key?: string;
    hosts?: string[];
    uses?: string[];
    ciphers?: string;
}

interface CertRecord {
    name: string;
    certificate: string;
    is_authority: boolean;
    hosts?: string[];
    uses?: string[];
    private_key_name?: string;
    ciphers?: string;
}

/**
 * Adds or updates a certificate in the hdbCertificate table.
 *
 * If `private_key` is provided, it will be written to disk (as `<name>.pem`) rather than
 * stored in the table. If no `private_key` is provided, existing stored keys are searched
 * for one that matches the certificate. Non-CA certificates require a matching private key
 * to be either provided or already stored.
 *
 * If `name` is omitted, the primary hostname (CN) is extracted from the certificate itself.
 *
 * @param req.name - Primary key for the hdbCertificate record. Falls back to the certificate's CN if omitted.
 * @param req.certificate - PEM-encoded certificate string to add or update.
 * @param req.is_authority - Whether this certificate is a Certificate Authority (CA).
 *   CA certs do not require an associated private key, but can have one.
 * @param req.private_key - Optional PEM-encoded private key. Written to disk and referenced
 *   by name in the table. If omitted, existing keys are checked for a match.
 * @param req.hosts - Optional list of hostnames this certificate is valid for.
 * @param req.uses - Optional list of use cases this certificate is assigned to.
 * @param req.ciphers - Optional cipher suite string associated with this certificate.
 * @throws {ClientError} If the certificate is not a CA and no matching private key is found.
 * @throws {ClientError} If `name` is omitted and the CN cannot be extracted from the certificate.
 * @returns A replication response with a `message` confirming the certificate name added.
 */
async function addCertificate(req: AddCertificateRequest) {
    const validation = validateBySchema(
        req,
        Joi.object({
            name: Joi.string().optional(),
            certificate: Joi.string().required(),
            is_authority: Joi.boolean().required(),
            private_key: Joi.string(),
            hosts: Joi.array(),
            uses: Joi.array(),
        })
    );
    if (validation) throw new ClientError(validation.message);

    const { name, certificate, private_key, is_authority } = req;
    const x509Cert = new X509Certificate(certificate);

    // Track whether we found a matching key among existing keys, and which one.
    let matchingKeyFound: boolean = false;
    let existingPrivateKeyName: string | undefined;
    const privateKeys: Map<any, any> = getPrivateKeys();

    if (private_key) {
        // A key was provided — check if we already have it stored so we don't duplicate it.
        for (const [keyName, key] of privateKeys) {
            if (private_key === key) {
                matchingKeyFound = true;
                existingPrivateKeyName = keyName;
                break;
            }
        }
    } else {
        // No key provided — search existing keys to see if one matches this cert.
        for (const [keyName, key] of privateKeys) {
            if (x509Cert.checkPrivateKey(createPrivateKey(key))) {
                matchingKeyFound = true;
                existingPrivateKeyName = keyName;
                break;
            }
        }
    }

    // CA certs don't require a private key, but non-CA certs must have one either
    // provided directly or already stored.
    if (!is_authority && !private_key && !matchingKeyFound)
        throw new ClientError('A suitable private key was not found for this certificate');

    // If no name was provided, fall back to extracting the CN from the cert itself.
    let certCn: string | undefined;
    if (!name) {
        try {
            certCn = getPrimaryHostName(x509Cert);
        } catch (err) {
            logger.error?.(err);
        }

        if (certCn == null)
            throw new ClientError('Error extracting certificate host name, please provide a name parameter');
    }

    const saniName: string = sanitizeName(name ?? certCn!);

    // Only write the key to disk if it's new (not already stored).
    if (private_key && !matchingKeyFound) {
        await writeFile(join(env.getHdbBasePath(), LICENSE_KEY_DIR_NAME, saniName + '.pem'), private_key);
        privateKeys.set(saniName, private_key);
    }

    const record: CertRecord = {
        name: name ?? certCn!,
        certificate,
        is_authority,
        hosts: req.hosts,
        uses: req.uses,
    };

    // Attach private_key_name for non-CA certs, and for CA certs that have an associated key.
    if (!is_authority || (is_authority && existingPrivateKeyName) || (is_authority && private_key)) {
        record.private_key_name = existingPrivateKeyName ?? saniName + '.pem';
    }

    if (req.ciphers) record.ciphers = req.ciphers;

    await setCertTable(record);
    const response: { message: string } = await replicateOperation(req);
    response.message = 'Successfully added certificate: ' + saniName;
    return response;
}

/**
 * Removes a certificate from the hdbCertificate table.
 *
 * If the certificate has an associated private key file, it will be deleted from disk —
 * but only if no other certificates reference the same key.
 *
 * @param req.name - Name of the certificate to remove. Must match an existing record.
 * @throws {ClientError} If no certificate with the given name is found.
 * @returns A replication response with a `message` confirming the certificate name removed.
 */
async function removeCertificate(req: { name: string }): Promise<{ message: string; replicated?: unknown[] }> {
    const validation = validateBySchema(
        req,
        Joi.object({
            name: Joi.string().required(),
        })
    );
    if (validation) throw new ClientError(validation.message);

    const { name } = req;
    const certificateTable = getCertTable();
    const certRecord: any = await certificateTable.get(name);
    if (!certRecord) throw new ClientError(`${name} not found`);

    const { private_key_name } = certRecord;
    if (private_key_name) {
        const matchingKeys = Array.from(
            await certificateTable.search([{ attribute: 'private_key_name', value: private_key_name }])
        );

        // Only delete the key file if this is the only cert referencing it.
        if (matchingKeys.length === 1 && matchingKeys[0].name === name) {
            try {
                logger.info?.('Removing private key named', private_key_name);
                await unlink(join(env.getHdbBasePath(), LICENSE_KEY_DIR_NAME, private_key_name));
            } catch (err) {
                logger.error?.('Failed to remove private key file', private_key_name, err);
            }
        }
    }

    await certificateTable.delete(name);
    const response: { message: string } = await replicateOperation(req);
    response.message = `Successfully removed ${name}`;
    return response;
}

/**
 * List all the records in hdbCertificate table
 * @returns {Promise<*[]>}
 */
async function listCertificates() {
    const certificateTable = getCertTable();
    let response = [];
    for await (const cert of certificateTable.search([])) {
        response.push(cert);
    }
    return response;
}

/**
 * Used to sanitize a cert common name or the 'name' param used in cert ops
 * @param cn
 * @returns {*}
 */
function sanitizeName(cn: string): string {
    return cn.replace(/[^a-z0-9.]/gi, '-');
}

// These will register the operations for the operations API. For now the method and schema are ignored,
// they are there for when build the REST interface for operations API
server.registerOperation?.({
    name: 'add_certificate',
    execute: addCertificate,
    httpMethod: 'PUT',
    parametersSchema: [{ name: 'hostname', in: 'path', schema: { type: 'string' } }],
});

server.registerOperation?.({
    name: 'remove_certificate',
    execute: removeCertificate,
    httpMethod: 'DELETE',
    parametersSchema: [{ name: 'hostname', in: 'path', schema: { type: 'string' } }],
});

server.registerOperation?.({
    name: 'list_certificates',
    execute: listCertificates,
    httpMethod: 'GET',
    parametersSchema: [{ name: 'hostname', in: 'path', schema: { type: 'string' } }],
});

server.registerOperation?.({
    name: 'create_csr',
    execute: createCsr,
    httpMethod: 'POST',
    parametersSchema: [{ name: 'hostname', in: 'path', schema: { type: 'string' } }],
});

server.registerOperation?.({
    name: 'sign_certificate',
    execute: signCertificate,
    httpMethod: 'POST',
    parametersSchema: [{ name: 'hostname', in: 'path', schema: { type: 'string' } }],
});
