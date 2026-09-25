import { createPrivateKey, ECDH, type KeyObject } from 'node:crypto';

/*
 * Nothing reads a stored SSH key until ssh loads it as the IdentityFile of a git deploy, where a key
 * it can't load fails as a generic auth error. So a supplied key is refused here when that load would
 * fail: the checks mirror OpenSSH's own loader (sshkey.c — `sshkey_parse_private2` for its format,
 * `sshkey_parse_private_pem_fileblob` for PEM), and the messages name the mistakes Harper Studio
 * names for the same keys.
 */

/** Far above any real private key (an RSA-16384 key is about 13 KB), and a bound on the work below. */
export const MAX_SSH_PRIVATE_KEY_LENGTH = 64 * 1024;

const PEM_BEGIN = /^-----BEGIN ([A-Z0-9 ]+)-----$/;
const OPENSSH_LABEL = 'OPENSSH PRIVATE KEY';
const PRIVATE_KEY_LABELS = new Set([
	OPENSSH_LABEL,
	'RSA PRIVATE KEY',
	'DSA PRIVATE KEY',
	'EC PRIVATE KEY',
	'PRIVATE KEY',
	'ENCRYPTED PRIVATE KEY',
]);
const PEM_KEY_ENCODINGS: Record<string, 'pkcs1' | 'sec1' | 'pkcs8'> = {
	'RSA PRIVATE KEY': 'pkcs1',
	'EC PRIVATE KEY': 'sec1',
	'PRIVATE KEY': 'pkcs8',
};
const PUBLIC_KEY_LABELS = new Set(['PUBLIC KEY', 'RSA PUBLIC KEY']);
const SSH2_PUBLIC_KEY_BEGIN = '---- BEGIN SSH2 PUBLIC KEY ----';
// A key blob starts with a 4-byte length, so the base64 after the algorithm always starts with "AAAA".
const PUBLIC_KEY_LINE =
	/(?:^|\s)((?:ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-nistp(?:256|384|521)|sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)(?:-cert-v01@openssh\.com)?)\s+AAAA/m;
const PEM_ENCRYPTED_HEADER = /^Proc-Type:\s*4,\s*ENCRYPTED$/i;
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/;

const OPENSSH_KEY_MAGIC = Buffer.from('openssh-key-v1\0', 'latin1');
const CERTIFICATE_SUFFIX = '-cert-v01@openssh.com';
// The `none` cipher's block size, which an unencrypted private section is padded to.
const UNENCRYPTED_BLOCK_SIZE = 8;
// OpenSSH's SSHBUF_MAX_BIGNUM, plus the leading zero byte a positive mpint may carry.
const MAX_MPINT_BYTES = 16384 / 8 + 1;
const MIN_RSA_BITS = 1024;
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SECRET_KEY_BYTES = 64;
const SSH_EC_CURVES = new Set(['prime256v1', 'secp384r1', 'secp521r1']);
// The shape of every SSH algorithm name; anything else in the type field is damage, not a type.
const KEY_TYPE_NAME = /^[a-z0-9-]{1,64}(?:@[a-z0-9.-]{1,64})?$/;

const FOR_EXAMPLE_A_NEW_KEY = ' — for example, a new deploy key from ssh-keygen -t ed25519 -N "".';
const EMPTY = 'The SSH key is empty.';
const PASSPHRASE_PROTECTED =
	"The SSH key is protected by a passphrase, which Harper can't enter when it runs git. " +
	`Use a key without one${FOR_EXAMPLE_A_NEW_KEY}`;
const DSA_KEY = `The SSH key is a DSA key, which current ssh no longer accepts. Use an Ed25519 key${FOR_EXAMPLE_A_NEW_KEY}`;
const SECURITY_KEY =
	'The SSH key only works with its hardware security key attached, and the server Harper runs git on ' +
	`has none. Use a regular key${FOR_EXAMPLE_A_NEW_KEY}`;
const DAMAGED = "The SSH key is damaged and can't be read. Copy it again from the original file.";
const PUBLIC_KEY_HINT = 'Use the private key — the file without the .pub extension.';

const unsupported = (what: string, name: string | undefined) =>
	`The SSH key's ${what}${name ? ` (${name})` : ''} isn't one ssh supports. ` +
	`Use an Ed25519, ECDSA or RSA key${FOR_EXAMPLE_A_NEW_KEY}`;

/**
 * `key` as ssh needs it in a file: every line trimmed, blank lines dropped, and a final newline. ssh
 * finds its format's BEGIN and END lines only at the start of a line and only newline-terminated,
 * and libcrypto rejects a PEM body with a blank line in it; none of that whitespace is ever part of
 * a key.
 */
export function normalizeSSHPrivateKey(key: string): string {
	return splitKeyLines(key).join('\n') + '\n';
}

function splitKeyLines(key: string): string[] {
	return key
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
}

/**
 * Explains why ssh couldn't load `key` — plaintext, as sent — as a private key once it is stored in
 * its normalized form, or returns undefined when it could.
 *
 * Ed25519 in PKCS#8 is accepted though only OpenSSH built against OpenSSL loads it (LibreSSL builds,
 * such as macOS's, don't): that's the build Harper's Linux hosts run.
 */
export function describeSSHPrivateKeyProblem(key: string): string | undefined {
	if (key.length > MAX_SSH_PRIVATE_KEY_LENGTH) {
		return `The SSH key is too long to be a private key (${key.length} characters). Send only the private key file.`;
	}
	const lines = splitKeyLines(key);
	if (lines.length === 0) return EMPTY;

	const labels = lines.map((line) => PEM_BEGIN.exec(line)?.[1]);
	const beginIndex = labels.findIndex((label) => label !== undefined && PRIVATE_KEY_LABELS.has(label));
	if (beginIndex === -1) return describeNonPrivateKey(lines, labels);

	// OpenSSH reads its own format only from a file that starts with the BEGIN line, while
	// libcrypto's PEM reader skips whatever precedes it — so only this format minds leading text.
	const label = labels[beginIndex] as string;
	if (beginIndex > 0 && label === OPENSSH_LABEL) {
		return `The SSH key has text before "${lines[beginIndex]}", and ssh reads this format only from the first line. Send only the private key.`;
	}

	const endLine = `-----END ${label}-----`;
	const endIndex = lines.indexOf(endLine, beginIndex + 1);
	if (endIndex === -1) return `The SSH key is incomplete: its "${endLine}" line is missing. Copy the whole file.`;

	// Anything after the END line is ignored by every format, so a public key pasted after it is harmless.
	return describeKeyBody(label, lines.slice(beginIndex + 1, endIndex));
}

function describeNonPrivateKey(lines: string[], labels: Array<string | undefined>): string {
	if (lines[0].startsWith('PuTTY-User-Key-File-')) {
		return (
			"The SSH key is a PuTTY key (.ppk), which ssh can't read. " +
			'In PuTTYgen, choose Conversions → Export OpenSSH key, and use that file instead.'
		);
	}
	if (
		lines.includes(SSH2_PUBLIC_KEY_BEGIN) ||
		labels.some((label) => label !== undefined && PUBLIC_KEY_LABELS.has(label))
	) {
		return `The SSH key is a public key. ${PUBLIC_KEY_HINT}`;
	}
	const otherLabel = labels.find((label) => label !== undefined);
	if (otherLabel) return `Expected an SSH private key, but found "-----BEGIN ${otherLabel}-----".`;
	const publicKeyAlgorithm = PUBLIC_KEY_LINE.exec(lines.join('\n'))?.[1];
	if (publicKeyAlgorithm) return `The SSH key looks like a public key ("${publicKeyAlgorithm} …"). ${PUBLIC_KEY_HINT}`;
	return (
		"The SSH key doesn't look like a private key. " +
		'Send the whole key file, including its "-----BEGIN" and "-----END" lines.'
	);
}

function describeKeyBody(label: string, bodyLines: string[]): string | undefined {
	if (label === 'DSA PRIVATE KEY') return DSA_KEY;
	if (label === 'ENCRYPTED PRIVATE KEY' || bodyLines.some((line) => PEM_ENCRYPTED_HEADER.test(line))) {
		return PASSPHRASE_PROTECTED;
	}
	// Inside a line, OpenSSH's own base64 decoder skips any ASCII whitespace; libcrypto's PEM decoder
	// skips only spaces and tabs.
	const base64 = bodyLines.join('').replace(label === OPENSSH_LABEL ? /[ \t\v\f\r]+/g : /[ \t]+/g, '');
	if (!base64 || !STRICT_BASE64.test(base64)) return DAMAGED;
	const bytes = Buffer.from(base64, 'base64');
	return label === OPENSSH_LABEL ? describeOpenSSHKeyProblem(bytes) : describePEMKeyProblem(label, bytes);
}

function describePEMKeyProblem(label: string, der: Buffer): string | undefined {
	let key: KeyObject;
	try {
		key = createPrivateKey({ key: der, format: 'der', type: PEM_KEY_ENCODINGS[label] });
	} catch {
		return DAMAGED;
	}
	switch (key.asymmetricKeyType) {
		case 'rsa': {
			const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
			return bits < MIN_RSA_BITS ? rsaTooShort(bits) : undefined;
		}
		case 'ec': {
			const curve = key.asymmetricKeyDetails?.namedCurve;
			return curve && SSH_EC_CURVES.has(curve) ? undefined : unsupported('curve', curve);
		}
		case 'ed25519':
			return undefined;
		case 'dsa':
			return DSA_KEY;
		default:
			return unsupported('type', key.asymmetricKeyType);
	}
}

function rsaTooShort(bits: number): string {
	return `The SSH key is a ${bits}-bit RSA key, and ssh requires at least ${MIN_RSA_BITS} bits. Use an Ed25519 key${FOR_EXAMPLE_A_NEW_KEY}`;
}

/** RFC 4251 fields; a read that would overrun the input returns undefined rather than throwing. */
class SSHFieldReader {
	bytes: Buffer;
	offset: number;

	constructor(bytes: Buffer, offset = 0) {
		this.bytes = bytes;
		this.offset = offset;
	}

	uint32(): number | undefined {
		if (this.remaining() < 4) return undefined;
		this.offset += 4;
		return this.bytes.readUInt32BE(this.offset - 4);
	}

	string(): Buffer | undefined {
		const length = this.uint32();
		if (length === undefined || this.remaining() < length) return undefined;
		this.offset += length;
		return this.bytes.subarray(this.offset - length, this.offset);
	}

	/** Like OpenSSH's `sshbuf_get_cstring`, which allows a NUL only as the last byte. */
	cstring(): string | undefined {
		const value = this.string();
		if (value === undefined) return undefined;
		const nul = value.indexOf(0);
		if (nul !== -1 && nul < value.length - 1) return undefined;
		return value.toString('latin1', 0, nul === -1 ? value.length : nul);
	}

	/** A non-negative mpint without its leading zeros, as OpenSSH's `sshbuf_get_bignum2` accepts one. */
	mpint(): Buffer | undefined {
		const value = this.string();
		if (value === undefined || value.length > MAX_MPINT_BYTES || (value.length > 0 && value[0] & 0x80))
			return undefined;
		let start = 0;
		while (start < value.length && value[start] === 0) start++;
		return value.subarray(start);
	}

	remaining(): number {
		return this.bytes.length - this.offset;
	}

	rest(): Buffer {
		return this.bytes.subarray(this.offset);
	}
}

/**
 * Reads one key type's fields, returning the public components they carry — which the key's public
 * blob and its private section must agree on (`sshkey_equal`) — or why ssh would refuse them.
 */
interface OpenSSHKeyFormat {
	readPublic(fields: SSHFieldReader): Buffer[] | string;
	readPrivate(fields: SSHFieldReader): Buffer[] | string;
}

const OPENSSH_KEY_FORMATS = new Map<string, OpenSSHKeyFormat>([
	['ssh-ed25519', { readPublic: readEd25519Public, readPrivate: readEd25519Private }],
	['ssh-rsa', { readPublic: readRSAPublic, readPrivate: readRSAPrivate }],
	['ecdsa-sha2-nistp256', ecdsaFormat('nistp256', 'prime256v1')],
	['ecdsa-sha2-nistp384', ecdsaFormat('nistp384', 'secp384r1')],
	['ecdsa-sha2-nistp521', ecdsaFormat('nistp521', 'secp521r1')],
]);

function readEd25519Public(fields: SSHFieldReader): Buffer[] | string {
	const publicKey = fields.string();
	return publicKey?.length === ED25519_PUBLIC_KEY_BYTES ? [publicKey] : DAMAGED;
}

function readEd25519Private(fields: SSHFieldReader): Buffer[] | string {
	const publicParts = readEd25519Public(fields);
	if (typeof publicParts === 'string') return publicParts;
	return fields.string()?.length === ED25519_SECRET_KEY_BYTES ? publicParts : DAMAGED;
}

function readRSAPublic(fields: SSHFieldReader): Buffer[] | string {
	const exponent = fields.mpint();
	const modulus = fields.mpint();
	if (!exponent || !modulus) return DAMAGED;
	return rsaModulusProblem(modulus) ?? [exponent, modulus];
}

function readRSAPrivate(fields: SSHFieldReader): Buffer[] | string {
	const modulus = fields.mpint();
	const exponent = fields.mpint();
	// d, iqmp, p and q, none of which is zero in a key that can sign
	for (let index = 0; index < 4; index++) {
		if (!fields.mpint()?.length) return DAMAGED;
	}
	if (!exponent || !modulus) return DAMAGED;
	return rsaModulusProblem(modulus) ?? [exponent, modulus];
}

function rsaModulusProblem(modulus: Buffer): string | undefined {
	const bits = modulus.length === 0 ? 0 : (modulus.length - 1) * 8 + (32 - Math.clz32(modulus[0]));
	return bits < MIN_RSA_BITS ? rsaTooShort(bits) : undefined;
}

function ecdsaFormat(curveName: string, nodeCurve: string): OpenSSHKeyFormat {
	const readPublic = (fields: SSHFieldReader): Buffer[] | string => {
		const curve = fields.cstring();
		const point = fields.string();
		return curve === curveName && point && isCurvePoint(point, nodeCurve) ? [point] : DAMAGED;
	};
	return {
		readPublic,
		readPrivate(fields) {
			const publicParts = readPublic(fields);
			if (typeof publicParts === 'string') return publicParts;
			return fields.mpint()?.length ? publicParts : DAMAGED;
		},
	};
}

function isCurvePoint(point: Buffer, curve: string): boolean {
	// a lone zero byte encodes the point at infinity, which convertKey would accept
	if (point.length < 2) return false;
	try {
		ECDH.convertKey(point, curve);
		return true;
	} catch {
		return false;
	}
}

/** The openssh-key-v1 container and the key inside it, laid out in PROTOCOL.key in the OpenSSH source. */
function describeOpenSSHKeyProblem(bytes: Buffer): string | undefined {
	if (!bytes.subarray(0, OPENSSH_KEY_MAGIC.length).equals(OPENSSH_KEY_MAGIC)) return DAMAGED;
	const container = new SSHFieldReader(bytes, OPENSSH_KEY_MAGIC.length);
	const cipherName = container.cstring();
	const kdfName = container.cstring();
	const kdfOptions = container.string();
	const keyCount = container.uint32();
	const publicBlob = container.string();
	if (cipherName === undefined || kdfName === undefined || kdfOptions === undefined || keyCount !== 1) return DAMAGED;
	if (publicBlob === undefined || publicBlob.length === 0) return DAMAGED;

	const publicFields = new SSHFieldReader(publicBlob);
	const keyType = publicFields.cstring();
	if (keyType === undefined) return DAMAGED;
	if (keyType.startsWith('ssh-dss')) return DSA_KEY;
	if (keyType.startsWith('sk-')) return SECURITY_KEY;
	// A certificate key gets only the container checks: ssh-keygen never writes one into a private-key
	// file, and parsing the certificate isn't worth it for that.
	const format = OPENSSH_KEY_FORMATS.get(keyType);
	if (!format && !keyType.endsWith(CERTIFICATE_SUFFIX)) {
		return KEY_TYPE_NAME.test(keyType) ? unsupported('type', keyType) : DAMAGED;
	}
	const publicParts = format?.readPublic(publicFields);
	if (typeof publicParts === 'string') return publicParts;
	if (format && publicFields.remaining() !== 0) return DAMAGED;

	if (kdfName !== 'none') return PASSPHRASE_PROTECTED;
	if (cipherName !== 'none') return DAMAGED;

	const privateSection = container.string();
	if (privateSection === undefined || container.remaining() !== 0) return DAMAGED;
	if (privateSection.length < UNENCRYPTED_BLOCK_SIZE || privateSection.length % UNENCRYPTED_BLOCK_SIZE !== 0) {
		return DAMAGED;
	}
	const privateFields = new SSHFieldReader(privateSection);
	const checkInt = privateFields.uint32();
	if (checkInt === undefined || checkInt !== privateFields.uint32()) return DAMAGED;
	if (!format) return undefined;

	if (privateFields.cstring() !== keyType) return DAMAGED;
	const privateParts = format.readPrivate(privateFields);
	if (typeof privateParts === 'string') return privateParts;
	if (privateFields.cstring() === undefined || !isDeterministicPadding(privateFields.rest())) return DAMAGED;
	return publicParts.length === privateParts.length &&
		publicParts.every((part, index) => part.equals(privateParts[index]))
		? undefined
		: DAMAGED;
}

function isDeterministicPadding(padding: Buffer): boolean {
	return padding.every((byte, index) => byte === ((index + 1) & 0xff));
}

const SSH_CONFIG_FIELDS = {
	host: { value: 'alias', example: 'my-repo.github.com' },
	hostname: { value: 'hostname', example: 'github.com' },
};

/**
 * Explains why `value` can't be written as the `Host` (`host`) or `HostName` (`hostname`) of an ssh
 * config block, or returns undefined when it can. The config is shared by every key on the node, so
 * each refusal is a value that would either break ssh's parse of the whole file (a second argument,
 * an unbalanced quote, a line break, or one that reads as a comment or an empty `=value`) or can
 * never be connected to (a leading dash).
 */
export function describeSSHConfigValueProblem(field: 'host' | 'hostname', value: string): string | undefined {
	const { value: noun, example } = SSH_CONFIG_FIELDS[field];
	const got = `; got ${JSON.stringify(value)}.`;
	if (!value) return `'${field}' must not be empty.`;
	if (/[\s\p{Cc}]/u.test(value)) {
		return `'${field}' must be a single ${noun} like "${example}", without spaces or line breaks${got}`;
	}
	if (/["']/.test(value)) return `'${field}' must not contain quotes${got}`;
	if (/^[-#=]/.test(value)) return `'${field}' must not start with "${value[0]}"${got}`;
	return undefined;
}
