import { createPrivateKey, createPublicKey, sign, verify, type KeyObject, type webcrypto } from 'node:crypto';

// Mirrors OpenSSH's loader (sshkey.c: `sshkey_parse_private2`, `sshkey_parse_private_pem_fileblob`),
// plus a signing check: refuse only a key ssh can't load, or can't authenticate with.

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
// Padding included: both of ssh's base64 decoders refuse a partial final quad.
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const OPENSSH_KEY_MAGIC = Buffer.from('openssh-key-v1\0', 'latin1');
const CERTIFICATE_SUFFIX = '-cert-v01@openssh.com';
// The `none` cipher's block size, which an unencrypted private section is padded to.
const UNENCRYPTED_BLOCK_SIZE = 8;
// OpenSSH's SSHBUF_MAX_BIGNUM, plus the leading zero byte a positive mpint may carry.
const MAX_MPINT_BYTES = 16384 / 8 + 1;
const MIN_RSA_BITS = 1024;
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SECRET_KEY_BYTES = 64;
const EC_ORDER_BITS: Record<string, number> = { prime256v1: 256, secp384r1: 384, secp521r1: 521 };
const SIGNING_CHECK = Buffer.from('harper ssh key check');
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
 * None of the whitespace this drops is ever part of a key, and ssh refuses a key that has it: OpenSSH
 * finds BEGIN and END only at a line start and newline-terminated, and libcrypto refuses a blank line
 * inside a PEM body.
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
 * Explains why ssh couldn't load `key` — plaintext, as sent — or authenticate with it once it is stored
 * in its normalized form, or returns undefined when it could.
 *
 * Ed25519 in PKCS#8 is accepted: OpenSSH 10 built against OpenSSL, as in Harper's Debian image, loads
 * it, though OpenSSH 9 (Ubuntu 24.04) and LibreSSL builds (macOS) don't.
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
			if (bits < MIN_RSA_BITS) return rsaTooShort(bits);
			const { n, d, p, q, dp, dq, qi } = key.export({ format: 'jwk' });
			const [modulus, exponent, primeP, primeQ, crtP, crtQ, coefficient] = [n, d, p, q, dp, dq, qi].map((value) =>
				toBigInt(Buffer.from(value ?? '', 'base64url'))
			);
			const agree = rsaComponentsAgree(modulus, exponent, primeP, primeQ, coefficient);
			if (!agree || crtP !== exponent % (primeP - 1n) || crtQ !== exponent % (primeQ - 1n)) return DAMAGED;
			break;
		}
		case 'ec': {
			const curve = key.asymmetricKeyDetails?.namedCurve;
			const orderBits = curve ? EC_ORDER_BITS[curve] : undefined;
			if (!orderBits) return unsupported('curve', curve);
			if (!isLargeEnoughScalar(Buffer.from(key.export({ format: 'jwk' }).d, 'base64url'), orderBits)) return DAMAGED;
			break;
		}
		case 'ed25519':
			break;
		case 'dsa':
			return DSA_KEY;
		default:
			return unsupported('type', key.asymmetricKeyType);
	}
	return signsFor(key, () => createPublicKey(key)) ? undefined : DAMAGED;
}

function rsaTooShort(bits: number): string {
	return `The SSH key is a ${bits}-bit RSA key, and ssh requires at least ${MIN_RSA_BITS} bits. Use an Ed25519 key${FOR_EXAMPLE_A_NEW_KEY}`;
}

/**
 * Whether `privateKey` makes a signature that `publicKey` — the public key ssh would present — verifies.
 * A key can load and still fail this, and then it can never authenticate.
 */
function signsFor(privateKey: KeyObject, publicKey: () => KeyObject): boolean {
	const digest = privateKey.asymmetricKeyType === 'ed25519' ? null : 'sha256';
	try {
		return verify(digest, SIGNING_CHECK, publicKey(), sign(digest, SIGNING_CHECK, privateKey));
	} catch {
		return false;
	}
}

function bitLength(bytes: Buffer): number {
	let start = 0;
	while (start < bytes.length && bytes[start] === 0) start++;
	return start === bytes.length ? 0 : (bytes.length - start - 1) * 8 + (32 - Math.clz32(bytes[start]));
}

/** OpenSSH's `sshkey_ec_validate_private` refuses a private scalar of half the order's bits or fewer. */
function isLargeEnoughScalar(scalar: Buffer, orderBits: number): boolean {
	return bitLength(scalar) > Math.floor(orderBits / 2);
}

const base64url = (value: Buffer | bigint) => {
	if (Buffer.isBuffer(value)) return value.toString('base64url');
	const hex = value.toString(16);
	return Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex').toString('base64url');
};
const toBigInt = (bytes: Buffer) => (bytes.length ? BigInt(`0x${bytes.toString('hex')}`) : 0n);
const jwkPrivateKey = (key: webcrypto.JsonWebKey) => createPrivateKey({ key, format: 'jwk' });
const jwkPublicKey = (key: webcrypto.JsonWebKey) => createPublicKey({ key, format: 'jwk' });

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
 * One key type's fields. The public blob and the private section each carry the public components,
 * and OpenSSH refuses a key whose two copies differ (`sshkey_equal`).
 */
interface OpenSSHKeyFormat {
	readPublic(fields: SSHFieldReader): Buffer[] | string;
	/** May throw when the fields don't make a key. */
	readPrivate(fields: SSHFieldReader): { publicParts: Buffer[]; privateKey: KeyObject } | string;
	publicKey(publicParts: Buffer[]): KeyObject;
}

const ed25519Format: OpenSSHKeyFormat = {
	readPublic(fields) {
		const publicKey = fields.string();
		return publicKey?.length === ED25519_PUBLIC_KEY_BYTES ? [publicKey] : DAMAGED;
	},
	readPrivate(fields) {
		const publicKey = fields.string();
		const secretKey = fields.string();
		// OpenSSH's bundled Ed25519 code (older releases, LibreSSL builds) signs with the secret key's second
		// half as the public key, so a key whose halves disagree fails there
		if (
			publicKey?.length !== ED25519_PUBLIC_KEY_BYTES ||
			secretKey?.length !== ED25519_SECRET_KEY_BYTES ||
			!secretKey.subarray(ED25519_PUBLIC_KEY_BYTES).equals(publicKey)
		) {
			return DAMAGED;
		}
		const seed = secretKey.subarray(0, ED25519_SECRET_KEY_BYTES - ED25519_PUBLIC_KEY_BYTES);
		return {
			publicParts: [publicKey],
			privateKey: jwkPrivateKey({ kty: 'OKP', crv: 'Ed25519', x: base64url(publicKey), d: base64url(seed) }),
		};
	},
	publicKey: ([publicKey]) => jwkPublicKey({ kty: 'OKP', crv: 'Ed25519', x: base64url(publicKey) }),
};

const rsaFormat: OpenSSHKeyFormat = {
	readPublic(fields) {
		const exponent = fields.mpint();
		const modulus = fields.mpint();
		if (!exponent || !modulus) return DAMAGED;
		return rsaModulusProblem(modulus) ?? [exponent, modulus];
	},
	readPrivate(fields) {
		const [modulus, exponent, privateExponent, iqmp, p, q] = Array.from({ length: 6 }, () => fields.mpint());
		if (!modulus || !exponent || !privateExponent || !iqmp || !p || !q) return DAMAGED;
		const tooShort = rsaModulusProblem(modulus);
		if (tooShort) return tooShort;
		const [n, d, primeP, primeQ, coefficient] = [modulus, privateExponent, p, q, iqmp].map(toBigInt);
		if (!rsaComponentsAgree(n, d, primeP, primeQ, coefficient)) return DAMAGED;
		return {
			publicParts: [exponent, modulus],
			privateKey: jwkPrivateKey({
				kty: 'RSA',
				n: base64url(modulus),
				e: base64url(exponent),
				d: base64url(privateExponent),
				p: base64url(p),
				q: base64url(q),
				dp: base64url(d % (primeP - 1n)),
				dq: base64url(d % (primeQ - 1n)),
				qi: base64url(iqmp),
			}),
		};
	},
	publicKey: ([exponent, modulus]) => jwkPublicKey({ kty: 'RSA', n: base64url(modulus), e: base64url(exponent) }),
};

/**
 * Whether an RSA key's stored components agree, as in any key a tool writes. One whose don't is
 * damaged, though OpenSSL's CRT fault fallback can still sign with it; checking here, rather than
 * leaving it to import, gives every Node version one verdict (Node 26 refuses some such keys on
 * import, older Node none). A factor under 2 also fails OpenSSH's own CRT derivation on load.
 */
function rsaComponentsAgree(n: bigint, d: bigint, p: bigint, q: bigint, coefficient: bigint): boolean {
	return p > 1n && q > 1n && p * q === n && d > 0n && (coefficient * q) % p === 1n;
}

function rsaModulusProblem(modulus: Buffer): string | undefined {
	const bits = bitLength(modulus);
	return bits < MIN_RSA_BITS ? rsaTooShort(bits) : undefined;
}

function ecdsaFormat(
	curveName: string,
	jwkCurve: string,
	coordinateBytes: number,
	orderBits: number
): OpenSSHKeyFormat {
	const readPublic = (fields: SSHFieldReader): Buffer[] | string => {
		const curve = fields.cstring();
		const point = fields.string();
		return curve === curveName && point && isUncompressedPoint(point, jwkCurve, coordinateBytes) ? [point] : DAMAGED;
	};
	const coordinates = (point: Buffer): webcrypto.JsonWebKey => ({
		kty: 'EC',
		crv: jwkCurve,
		x: base64url(point.subarray(1, 1 + coordinateBytes)),
		y: base64url(point.subarray(1 + coordinateBytes)),
	});
	return {
		readPublic,
		readPrivate(fields) {
			const publicParts = readPublic(fields);
			if (typeof publicParts === 'string') return publicParts;
			const scalar = fields.mpint();
			if (!scalar || scalar.length > coordinateBytes || !isLargeEnoughScalar(scalar, orderBits)) return DAMAGED;
			const d = Buffer.concat([Buffer.alloc(coordinateBytes - scalar.length), scalar]);
			return { publicParts, privateKey: jwkPrivateKey({ ...coordinates(publicParts[0]), d: base64url(d) }) };
		},
		publicKey: ([point]) => jwkPublicKey(coordinates(point)),
	};
}

/** OpenSSH reads only an uncompressed point (`sshbuf_get_eckey`), and it must lie on the curve. */
function isUncompressedPoint(point: Buffer, jwkCurve: string, coordinateBytes: number): boolean {
	if (point.length !== 1 + 2 * coordinateBytes || point[0] !== 4) return false;
	try {
		jwkPublicKey({
			kty: 'EC',
			crv: jwkCurve,
			x: base64url(point.subarray(1, 1 + coordinateBytes)),
			y: base64url(point.subarray(1 + coordinateBytes)),
		});
		return true;
	} catch {
		return false;
	}
}

const OPENSSH_KEY_FORMATS = new Map<string, OpenSSHKeyFormat>([
	['ssh-ed25519', ed25519Format],
	['ssh-rsa', rsaFormat],
	['ecdsa-sha2-nistp256', ecdsaFormat('nistp256', 'P-256', 32, 256)],
	['ecdsa-sha2-nistp384', ecdsaFormat('nistp384', 'P-384', 48, 384)],
	['ecdsa-sha2-nistp521', ecdsaFormat('nistp521', 'P-521', 66, 521)],
]);

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
	let privatePart: ReturnType<OpenSSHKeyFormat['readPrivate']>;
	try {
		privatePart = format.readPrivate(privateFields);
	} catch {
		return DAMAGED;
	}
	if (typeof privatePart === 'string') return privatePart;
	if (privateFields.cstring() === undefined || !isDeterministicPadding(privateFields.rest())) return DAMAGED;
	const privateCopy = privatePart.publicParts;
	if (
		privateCopy.length !== publicParts.length ||
		publicParts.some((part, index) => !part.equals(privateCopy[index]))
	) {
		return DAMAGED;
	}
	return signsFor(privatePart.privateKey, () => format.publicKey(publicParts)) ? undefined : DAMAGED;
}

function isDeterministicPadding(padding: Buffer): boolean {
	return padding.every((byte, index) => byte === ((index + 1) & 0xff));
}

const SSH_CONFIG_FIELDS = {
	host: { value: 'alias', example: 'my-repo.github.com' },
	hostname: { value: 'hostname', example: 'github.com' },
};

/**
 * The config is shared by every key on the node, so each refusal is a value that breaks ssh's parse of
 * the whole file (OpenSSH before 8.7 also splits an argument at "="), makes its block apply to other
 * keys' aliases (a pattern), or can never connect (a leading dash).
 */
export function describeSSHConfigValueProblem(field: 'host' | 'hostname', value: string): string | undefined {
	const { value: noun, example } = SSH_CONFIG_FIELDS[field];
	const got = `; got ${JSON.stringify(value)}.`;
	if (!value) return `'${field}' must not be empty.`;
	if (/[\s\p{Cc}]/u.test(value)) {
		return `'${field}' must be a single ${noun} like "${example}", without spaces or line breaks${got}`;
	}
	if (/["'=]/.test(value)) return `'${field}' must not contain quotes or "="${got}`;
	if (field === 'host' && /[*?!]/.test(value)) {
		return `'host' must be one alias, not a pattern: "*", "?" and "!" also match other keys' aliases${got}`;
	}
	if (/^[-#]/.test(value)) return `'${field}' must not start with "${value[0]}"${got}`;
	return undefined;
}
