// Built at runtime from fresh keypairs, so that no key-shaped block sits in the repo for a secret
// scanner to flag. Every openssh-key-v1 field can be overridden, to damage exactly one.
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const OPENSSH_LABEL = 'OPENSSH PRIVATE KEY';

export function uint32(value) {
	const bytes = Buffer.alloc(4);
	bytes.writeUInt32BE(value);
	return bytes;
}

export function sshString(value) {
	const body = Buffer.isBuffer(value) ? value : Buffer.from(value, 'latin1');
	return Buffer.concat([uint32(body.length), body]);
}

export function mpint(bytes) {
	return sshString(bytes.length && bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

const jwkBytes = (value) => Buffer.from(value, 'base64url');

function derInteger(bytes) {
	const value = bytes.length && bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes;
	return Buffer.concat([Buffer.from([0x02]), derLength(value.length), value]);
}

function derLength(length) {
	if (length < 0x80) return Buffer.from([length]);
	const bytes = [];
	for (let remaining = length; remaining > 0; remaining >>= 8) bytes.unshift(remaining & 0xff);
	return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** A PKCS#1 RSAPrivateKey from JWK components, which may disagree with each other (Node 26 won't import those). */
export function pkcs1Der({ n, e, d, p, q, dp, dq, qi }) {
	const fields = Buffer.concat([
		Buffer.from([0x02, 0x01, 0x00]),
		...[n, e, d, p, q, dp, dq, qi].map((value) => derInteger(Buffer.from(value, 'base64url'))),
	]);
	return Buffer.concat([Buffer.from([0x30]), derLength(fields.length), fields]);
}

export function armor(label, bytes) {
	const width = label === OPENSSH_LABEL ? 70 : 64;
	const lines = bytes.toString('base64').match(new RegExp(`.{1,${width}}`, 'g')) ?? [];
	return [`-----BEGIN ${label}-----`, ...lines, `-----END ${label}-----`].join('\n') + '\n';
}

/**
 * The type-specific public and private fields of a freshly generated key, as OpenSSH lays them out.
 * `rsaPrivate` replaces RSA private components (`d`, `qi`, `p`, `q`) by name, or is a function from the
 * generated components to the replacements.
 */
export function openSSHKeyFields(keyType, { bits = 2048, rsaPrivate = {} } = {}) {
	if (keyType === 'ssh-ed25519') {
		const { x, d } = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
		const publicKey = jwkBytes(x);
		return {
			publicFields: sshString(publicKey),
			privateFields: Buffer.concat([sshString(publicKey), sshString(Buffer.concat([jwkBytes(d), publicKey]))]),
		};
	}
	if (keyType === 'ssh-rsa') {
		const { n, e, d, p, q, qi } = generateKeyPairSync('rsa', { modulusLength: bits }).privateKey.export({
			format: 'jwk',
		});
		const [modulus, exponent] = [n, e].map(jwkBytes);
		const generated = { d: jwkBytes(d), qi: jwkBytes(qi), p: jwkBytes(p), q: jwkBytes(q) };
		const parts = { ...generated, ...(typeof rsaPrivate === 'function' ? rsaPrivate(generated) : rsaPrivate) };
		return {
			publicFields: Buffer.concat([mpint(exponent), mpint(modulus)]),
			privateFields: Buffer.concat([
				mpint(modulus),
				mpint(exponent),
				...[parts.d, parts.qi, parts.p, parts.q].map(mpint),
			]),
		};
	}
	const size = keyType.slice(-3);
	const namedCurve = { 256: 'P-256', 384: 'P-384', 521: 'P-521' }[size];
	const { x, y, d } = generateKeyPairSync('ec', { namedCurve }).privateKey.export({ format: 'jwk' });
	const curve = sshString(`nistp${size}`);
	const point = sshString(Buffer.concat([Buffer.from([4]), jwkBytes(x), jwkBytes(y)]));
	return {
		publicFields: Buffer.concat([curve, point]),
		privateFields: Buffer.concat([curve, point, mpint(jwkBytes(d))]),
	};
}

export function padTo(section, blockSize = 8) {
	const length = (blockSize - (section.length % blockSize)) % blockSize;
	return Buffer.concat([section, Buffer.from(Array.from({ length }, (_, index) => index + 1))]);
}

/** The openssh-key-v1 container's bytes; every field defaults to a valid, unencrypted key. */
export function openSSHKeyBytes({
	keyType = 'ssh-ed25519',
	fields = openSSHKeyFields(keyType),
	cipherName = 'none',
	kdfName = cipherName === 'none' ? 'none' : 'bcrypt',
	keyCount = 1,
	publicBlob = Buffer.concat([sshString(keyType), fields.publicFields]),
	checkInts = [0x5ca1ab1e, 0x5ca1ab1e],
	privateKeyType = keyType,
	privateFields = fields.privateFields,
	comment = 'harper-test',
	privateSection = padTo(
		Buffer.concat([
			uint32(checkInts[0]),
			uint32(checkInts[1]),
			sshString(privateKeyType),
			privateFields,
			sshString(comment),
		])
	),
	trailing = Buffer.alloc(0),
} = {}) {
	return Buffer.concat([
		Buffer.from('openssh-key-v1\0', 'latin1'),
		sshString(cipherName),
		sshString(kdfName),
		sshString(''),
		uint32(keyCount),
		sshString(publicBlob),
		sshString(privateSection),
		trailing,
	]);
}

export function openSSHPrivateKey(shape = {}) {
	return armor(OPENSSH_LABEL, openSSHKeyBytes(shape));
}

const publicKeyEncoding = { type: 'spki', format: 'pem' };

/** A PEM private key from node:crypto, e.g. `pemPrivateKey('ec', 'sec1', { namedCurve: 'P-256' })`. */
export function pemPrivateKey(type, encoding, options = {}) {
	return generateKeyPairSync(type, {
		...options,
		publicKeyEncoding,
		privateKeyEncoding: { type: encoding, format: 'pem', ...options.privateKeyEncoding },
	}).privateKey;
}

export const hasSSHKeygen = (() => {
	try {
		execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' });
		return true;
	} catch (error) {
		// `-?` is not a real flag: ssh-keygen prints usage and exits non-zero, which still proves it ran.
		return error.code !== 'ENOENT';
	}
})();

export const hasSSH = (() => {
	try {
		execFileSync('ssh', ['-V'], { stdio: 'ignore' });
		return true;
	} catch (error) {
		return error.code !== 'ENOENT';
	}
})();

/**
 * Whether this host's `ssh-keygen` loads `key` and signs with it for its own public key — what
 * authenticating with it takes. A key can load and still fail this.
 */
export function sshKeygenSigns(key) {
	const dir = mkdtempSync(join(tmpdir(), 'ssh-key-oracle-'));
	try {
		const file = join(dir, 'id');
		const data = join(dir, 'data');
		writeFileSync(file, key, { mode: 0o600 });
		writeFileSync(data, 'harper');
		// `-Y sign` takes the public half from id.pub, which a PEM private key doesn't carry itself
		const publicKey = execFileSync('ssh-keygen', ['-y', '-P', '', '-f', file], { stdio: ['ignore', 'pipe', 'ignore'] });
		writeFileSync(`${file}.pub`, publicKey);
		execFileSync('ssh-keygen', ['-Y', 'sign', '-f', file, '-n', 'harper', data], { stdio: 'ignore' });
		execFileSync('ssh-keygen', ['-Y', 'check-novalidate', '-n', 'harper', '-s', `${data}.sig`], {
			input: 'harper',
			stdio: ['pipe', 'ignore', 'ignore'],
		});
		return true;
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Whether this host's `ssh-keygen` loads `key` from a file, the way ssh loads an IdentityFile. */
export function sshKeygenLoads(key) {
	const dir = mkdtempSync(join(tmpdir(), 'ssh-key-oracle-'));
	try {
		const file = join(dir, 'id');
		writeFileSync(file, key, { mode: 0o600 });
		execFileSync('ssh-keygen', ['-y', '-P', '', '-f', file], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
