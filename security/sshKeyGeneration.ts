import { generateKeyPair, randomBytes, type KeyObject } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Mints ed25519 SSH keypairs in process, for `add_ssh_key generate=true`.
 *
 * Node's crypto can generate the keypair but cannot serialize it the way SSH needs it: its `pkcs8`
 * and `spki` PEM exports are formats OpenSSH refuses to load for ed25519 (`ssh-keygen -y` reports
 * `invalid format`), and a PEM public key is not what a host like GitHub accepts as a deploy key.
 * So the raw 32-byte values are encoded here into the two formats SSH actually reads: the
 * `openssh-key-v1` private key container and the one-line `ssh-ed25519 <base64> <comment>` public
 * key. That keeps generation inside this process — no `ssh-keygen` subprocess (which does not exist
 * on a stock Windows host) and no plaintext private key written to a temp file on the way.
 */

const generateKeyPairAsync = promisify(generateKeyPair);

const SSH_ED25519 = 'ssh-ed25519';
// The `none` cipher has no block size of its own; OpenSSH still pads the private section to 8.
const UNENCRYPTED_BLOCK_SIZE = 8;
// ssh-keygen wraps the base64 body of a private key at 70 columns.
const PEM_LINE_LENGTH = 70;

/**
 * An RFC 4251 §5 `string`: a big-endian uint32 length followed by that many bytes. Every field in
 * both SSH key formats below is one of these.
 */
function sshString(value: string | Buffer): Buffer {
	const body = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
	const length = Buffer.alloc(4);
	length.writeUInt32BE(body.length);
	return Buffer.concat([length, body]);
}

/**
 * The raw 32 bytes behind an ed25519 key. JWK is the export format that hands these back directly:
 * `x` is the public key, `d` the private seed. The `spki`/`pkcs8` exports carry the same bytes
 * behind DER headers that would have to be sliced off by offset.
 */
function rawKeyBytes(key: KeyObject, member: 'x' | 'd'): Buffer {
	const jwk = key.export({ format: 'jwk' }) as { x?: string; d?: string };
	const value = jwk[member];
	if (!value) throw new Error(`ed25519 JWK export is missing '${member}'`);
	return Buffer.from(value, 'base64url');
}

function wrapBase64(value: string): string {
	const lines: string[] = [];
	for (let offset = 0; offset < value.length; offset += PEM_LINE_LENGTH) {
		lines.push(value.slice(offset, offset + PEM_LINE_LENGTH));
	}
	return lines.join('\n');
}

/**
 * Generates an ed25519 keypair and returns it in OpenSSH's own formats.
 *
 * @param comment - the comment to embed in both halves, as `ssh-keygen -C` would. Spaces are fine —
 * ssh treats the rest of the line as the comment — but a line break is rejected, see below.
 * @returns `privateKey` as an unencrypted `openssh-key-v1` PEM (what goes in an `IdentityFile`) and
 * `publicKey` as a single `ssh-ed25519 <base64> <comment>` line (what a host registers).
 */
export async function generateEd25519SSHKeyPair(comment: string): Promise<{
	privateKey: string;
	publicKey: string;
}> {
	// The comment lands verbatim on the one-line public key, so a line break would split it in two and
	// leave the tail parseable as a separate entry by whatever consumes the key (an `authorized_keys`
	// file, a deploy-key field). Today's only caller derives the comment from a key name already
	// constrained to `[a-zA-Z0-9-_]` by `SSH_KEY_NAME_REGEX`, so this is unreachable — but that guard
	// lives in another module, and this one is exported, so the invariant is kept with the code that
	// depends on it. A plain Error rather than a ClientError: reaching it means a caller bug, not bad
	// client input.
	if (/[\r\n]/.test(comment)) throw new Error('SSH key comment must not contain a line break');

	const { publicKey, privateKey } = await generateKeyPairAsync('ed25519');
	const rawPublicKey = rawKeyBytes(publicKey, 'x');
	const seed = rawKeyBytes(privateKey, 'd');

	const publicKeyBlob = Buffer.concat([sshString(SSH_ED25519), sshString(rawPublicKey)]);

	// The private section, which for an unencrypted key is stored in the clear: a check value
	// repeated twice (OpenSSH's canary for a wrong passphrase), the key, its comment, then 1,2,3…
	// padding out to the block size.
	const checkValue = randomBytes(4);
	const privateSection = Buffer.concat([
		checkValue,
		checkValue,
		publicKeyBlob,
		// an ed25519 private key is stored as seed || public key, matching libsodium's layout
		sshString(Buffer.concat([seed, rawPublicKey])),
		sshString(comment),
	]);
	const padLength =
		(UNENCRYPTED_BLOCK_SIZE - (privateSection.length % UNENCRYPTED_BLOCK_SIZE)) % UNENCRYPTED_BLOCK_SIZE;
	const padding = Buffer.from(Array.from({ length: padLength }, (_, index) => index + 1));

	const keyFile = Buffer.concat([
		Buffer.from('openssh-key-v1\0', 'utf8'),
		sshString('none'), // ciphername
		sshString('none'), // kdfname
		sshString(''), // kdfoptions
		Buffer.from([0, 0, 0, 1]), // one key follows
		sshString(publicKeyBlob),
		sshString(Buffer.concat([privateSection, padding])),
	]);

	return {
		privateKey:
			'-----BEGIN OPENSSH PRIVATE KEY-----\n' +
			wrapBase64(keyFile.toString('base64')) +
			'\n-----END OPENSSH PRIVATE KEY-----\n',
		publicKey: `${SSH_ED25519} ${publicKeyBlob.toString('base64')} ${comment}`,
	};
}
