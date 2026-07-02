/**
 * Pure env-secret envelope cryptography — intentionally free of Harper-core imports so it is
 * unit-testable on its own. Hybrid scheme (see core/docs/env-secret-encryption.md): AES-256-GCM
 * encrypts the value, RSA-OAEP(SHA-256) wraps the AES key. Functions operate on the base64url
 * envelope BODY (the bytes after the `enc:v1:` marker); marker handling lives in envSecrets.ts.
 */
import {
	publicEncrypt,
	privateDecrypt,
	createCipheriv,
	createDecipheriv,
	createPublicKey,
	createHash,
	randomBytes,
	constants,
} from 'node:crypto';

export interface EnvelopeFields {
	kid?: string;
	k: string;
	iv: string;
	ct: string;
	tag: string;
}

/** SHA-256 (hex) of the DER SPKI public key — a stable key id used as the envelope `kid`. */
export function fingerprintOf(publicKeyPem: string): string {
	const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
	return createHash('sha256').update(der).digest('hex');
}

/**
 * Reference client-side encryption: returns the base64url envelope body for `enc:v1:<body>`. The
 * server never encrypts, but this is the single source of truth for the wire format and is what the
 * tests and the documented client example exercise.
 */
export function encryptEnvelope(plaintext: string, publicKeyPem: string, kid: string): string {
	const aesKey = randomBytes(32);
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
	const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	const k = publicEncrypt({ key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aesKey);
	const envelope: EnvelopeFields = {
		kid,
		k: k.toString('base64'),
		iv: iv.toString('base64'),
		ct: ct.toString('base64'),
		tag: tag.toString('base64'),
	};
	return Buffer.from(JSON.stringify(envelope)).toString('base64url');
}

/**
 * Decrypt a base64url envelope body. These are the security guarantees of the feature and throw on:
 * a malformed/incomplete envelope, a `kid` that doesn't match this node's key, or a failed GCM
 * authentication tag (any tampering with `ct`/`tag` makes `decipher.final()` throw).
 */
export function decryptEnvelope(body: string, privateKeyPem: string, keyFingerprint: string): string {
	let env: EnvelopeFields;
	try {
		env = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
	} catch {
		throw new Error('malformed env-secret envelope');
	}
	if (
		!env ||
		typeof env !== 'object' ||
		typeof env.k !== 'string' ||
		typeof env.iv !== 'string' ||
		typeof env.ct !== 'string' ||
		typeof env.tag !== 'string'
	) {
		throw new Error('malformed env-secret envelope');
	}
	if (env.kid && env.kid !== keyFingerprint) {
		throw new Error(`no env-secrets key for kid ${env.kid}`);
	}
	const aesKey = privateDecrypt(
		{ key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
		Buffer.from(env.k, 'base64')
	);
	const decipher = createDecipheriv('aes-256-gcm', aesKey, Buffer.from(env.iv, 'base64'));
	decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
	return Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]).toString('utf8');
}
