import { generateKeyPairSync, sign } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

/**
 * Public key PEM for use with HARPER_LICENSE_PUBLIC_KEY env var.
 */
export const testPublicKeyPEM = publicKey.export({ type: 'spki', format: 'pem' });

/**
 * Creates a signed test license with the given payload overrides.
 * All quota fields default to -1 (unlimited). Expiration defaults to 1 year from now.
 *
 * @param {Partial<import('../../licensing/validation.ts').LicensePayload>} overrides
 * @returns {string} Encoded license string (header.payload.signature)
 */
export function createTestLicense(overrides = {}) {
	const header = {
		typ: 'Harper-License',
		alg: 'EdDSA',
	};

	const payload = {
		id: overrides.id ?? `test-license-${Date.now()}`,
		level: overrides.level ?? 1,
		reads: overrides.reads ?? -1,
		writes: overrides.writes ?? -1,
		readBytes: overrides.readBytes ?? -1,
		writeBytes: overrides.writeBytes ?? -1,
		realTimeMessages: overrides.realTimeMessages ?? -1,
		realTimeBytes: overrides.realTimeBytes ?? -1,
		cpuTime: overrides.cpuTime ?? -1,
		storage: overrides.storage ?? -1,
		expiration: overrides.expiration ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
		...overrides,
	};

	const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
	const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
	const signature = sign(null, Buffer.from(`${headerB64}.${payloadB64}`, 'utf8'), privateKey);
	const signatureB64 = signature.toString('base64url');

	return `${headerB64}.${payloadB64}.${signatureB64}`;
}
