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

/** A decoded envelope: the base64 fields turned into buffers, ready to unwrap + open. */
export interface ParsedEnvelope {
	kid?: string;
	k: Buffer; // RSA-OAEP-wrapped AES key
	iv: Buffer;
	ct: Buffer;
	tag: Buffer;
}

/** Parse + validate a base64url envelope body. Throws on malformed/incomplete input. */
export function parseEnvelope(body: string): ParsedEnvelope {
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
	return {
		kid: env.kid,
		k: Buffer.from(env.k, 'base64'),
		iv: Buffer.from(env.iv, 'base64'),
		ct: Buffer.from(env.ct, 'base64'),
		tag: Buffer.from(env.tag, 'base64'),
	};
}

/** The RSA-OAEP(SHA-256) private-key operation: unwrap the envelope's wrapped AES key. */
export function unwrapWithPrivateKey(wrappedKey: Buffer, privateKeyPem: string): Buffer {
	return privateDecrypt(
		{ key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
		wrappedKey
	);
}

/** AES-256-GCM decrypt given the unwrapped AES key. Throws on a failed auth tag (tamper). */
export function openEnvelope(env: ParsedEnvelope, aesKey: Buffer): string {
	const decipher = createDecipheriv('aes-256-gcm', aesKey, env.iv);
	decipher.setAuthTag(env.tag);
	return Buffer.concat([decipher.update(env.ct), decipher.final()]).toString('utf8');
}

/**
 * Convenience decrypt with the private key in hand (used by the file-backend fast path and tests).
 * The custody-agnostic path is `decryptEnvelopeWithCustody` in keyCustody.ts, which keeps the key
 * inside the custody backend.
 */
export function decryptEnvelope(body: string, privateKeyPem: string, keyFingerprint: string): string {
	const env = parseEnvelope(body);
	if (env.kid && env.kid !== keyFingerprint) {
		throw new Error(`no env-secrets key for kid ${env.kid}`);
	}
	return openEnvelope(env, unwrapWithPrivateKey(env.k, privateKeyPem));
}
