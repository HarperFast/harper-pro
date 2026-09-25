/**
 * Both halves of the contract: every key ssh loads and signs with is accepted, and every other is
 * refused with a message naming the mistake. The oracle suites check that against the host's real
 * `ssh-keygen` and `ssh -G` where they exist (CI's Ubuntu runners). Policy rather than ssh behavior,
 * asserted as such: DSA is refused though OpenSSH before 10 loads it, and Ed25519 in PKCS#8 is
 * accepted though only OpenSSL builds of OpenSSH load it.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createECDH, createPrivateKey, ECDH, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	armor,
	hasSSH,
	hasSSHKeygen,
	mpint,
	OPENSSH_LABEL,
	openSSHKeyBytes,
	openSSHKeyFields,
	openSSHPrivateKey,
	padTo,
	pemPrivateKey,
	sshKeygenLoads,
	sshKeygenSigns,
	sshString,
	uint32,
} from './sshKeyFixtures.mjs';

const PASSPHRASE = 'The SSH key is protected by a passphrase';
const DSA = 'The SSH key is a DSA key';
const FIDO = 'The SSH key only works with its hardware security key attached';
const DAMAGED = "The SSH key is damaged and can't be read. Copy it again from the original file.";
const PUBLIC_KEY_HINT = 'Use the private key — the file without the .pub extension.';
const UNSUPPORTED = "isn't one ssh supports";

describe('SSH private key validation', () => {
	let describeSSHPrivateKeyProblem;
	let normalizeSSHPrivateKey;
	let MAX_SSH_PRIVATE_KEY_LENGTH;
	let generateEd25519SSHKeyPair;
	let keys;

	before(async function () {
		this.timeout(60000);
		({ describeSSHPrivateKeyProblem, normalizeSSHPrivateKey, MAX_SSH_PRIVATE_KEY_LENGTH } =
			await import('#src/security/sshKeyValidation'));
		({ generateEd25519SSHKeyPair } = await import('#src/security/sshKeyGeneration'));
		keys = {
			'an OpenSSH Ed25519 key (as generate: true mints it)': (await generateEd25519SSHKeyPair('harper:test'))
				.privateKey,
			'an OpenSSH Ed25519 key': openSSHPrivateKey({ keyType: 'ssh-ed25519' }),
			'an OpenSSH RSA key': openSSHPrivateKey({ keyType: 'ssh-rsa' }),
			'an OpenSSH ECDSA P-256 key': openSSHPrivateKey({ keyType: 'ecdsa-sha2-nistp256' }),
			'an OpenSSH ECDSA P-384 key': openSSHPrivateKey({ keyType: 'ecdsa-sha2-nistp384' }),
			'an OpenSSH ECDSA P-521 key': openSSHPrivateKey({ keyType: 'ecdsa-sha2-nistp521' }),
			'a PKCS#1 RSA key': pemPrivateKey('rsa', 'pkcs1', { modulusLength: 2048 }),
			'a PKCS#8 RSA key': pemPrivateKey('rsa', 'pkcs8', { modulusLength: 2048 }),
			'a SEC1 EC key': pemPrivateKey('ec', 'sec1', { namedCurve: 'P-256' }),
			'a PKCS#8 EC P-384 key': pemPrivateKey('ec', 'pkcs8', { namedCurve: 'P-384' }),
			'a SEC1 EC P-521 key': pemPrivateKey('ec', 'sec1', { namedCurve: 'P-521' }),
		};
	});

	describe('accepts', () => {
		it('every kind of key ssh loads, as generated', () => {
			for (const [kind, key] of Object.entries(keys)) {
				assert.equal(describeSSHPrivateKeyProblem(key), undefined, kind);
			}
		});

		it('an Ed25519 key in PKCS#8, which OpenSSL builds of OpenSSH (Linux) load', () => {
			assert.equal(describeSSHPrivateKeyProblem(pemPrivateKey('ed25519', 'pkcs8')), undefined);
		});

		it('a 1024-bit RSA key, the smallest ssh loads', () => {
			assert.equal(describeSSHPrivateKeyProblem(pemPrivateKey('rsa', 'pkcs1', { modulusLength: 1024 })), undefined);
		});

		it('text before a PEM key, which libcrypto skips, and text after any END line', () => {
			const pem = keys['a PKCS#1 RSA key'];
			const openSSH = keys['an OpenSSH Ed25519 key'];
			assert.equal(describeSSHPrivateKeyProblem(`Bag Attributes\n${pem}`), undefined);
			assert.equal(describeSSHPrivateKeyProblem(`${openSSH}ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 me@laptop\n`), undefined);
		});

		it("spaces inside a body line, which both of ssh's base64 decoders skip", () => {
			for (const key of [keys['an OpenSSH RSA key'], keys['a PKCS#8 RSA key']]) {
				const spaced = key.replace(/\n([A-Za-z0-9+/]{10})/g, '\n$1 \t');
				assert.equal(describeSSHPrivateKeyProblem(spaced), undefined);
			}
		});

		it("a comment ending in a NUL, which OpenSSH's string reader allows", () => {
			const key = openSSHPrivateKey({ comment: 'c\0' });
			assert.equal(describeSSHPrivateKeyProblem(key), undefined);
			if (hasSSHKeygen) assert.ok(sshKeygenSigns(key), 'ssh signs with it too');
		});

		it('an OpenSSH private section already block-aligned, with no padding at all', () => {
			const fields = openSSHKeyFields('ssh-ed25519');
			const section = [1, 2, 3, 4, 5, 6, 7, 8]
				.map((length) =>
					Buffer.concat([
						uint32(9),
						uint32(9),
						sshString('ssh-ed25519'),
						fields.privateFields,
						sshString('c'.repeat(length)),
					])
				)
				.find((candidate) => candidate.length % 8 === 0);
			const key = openSSHPrivateKey({ fields, privateSection: section });
			assert.equal(describeSSHPrivateKeyProblem(key), undefined);
			if (hasSSHKeygen) assert.ok(sshKeygenLoads(key), 'ssh loads it too');
		});

		it('a form feed inside an OpenSSH body line, which only OpenSSH’s own decoder skips', () => {
			const openSSH = keys['an OpenSSH Ed25519 key'].replace(/\n([A-Za-z0-9+/]{10})/, '\n$1\f');
			const pem = keys['a PKCS#8 RSA key'].replace(/\n([A-Za-z0-9+/]{10})/, '\n$1\f');
			assert.equal(describeSSHPrivateKeyProblem(openSSH), undefined);
			assert.equal(describeSSHPrivateKeyProblem(pem), DAMAGED);
		});
	});

	describe('normalizeSSHPrivateKey', () => {
		it('drops blank lines and the whitespace around each line, and ends with a newline', () => {
			assert.equal(normalizeSSHPrivateKey('\n  a  \n\n\tb\r\n   \nc'), 'a\nb\nc\n');
		});

		it('turns an indented, CRLF, double-spaced paste with a byte-order mark back into the key', () => {
			for (const key of [keys['an OpenSSH Ed25519 key'], keys['a PKCS#1 RSA key']]) {
				const pasted =
					'\uFEFF' +
					key
						.trimEnd()
						.split('\n')
						.map((line) => `    ${line}  `)
						.join('\r\n\r\n');
				assert.equal(describeSSHPrivateKeyProblem(pasted), undefined);
				assert.equal(normalizeSSHPrivateKey(pasted), key);
				assert.equal(normalizeSSHPrivateKey(normalizeSSHPrivateKey(pasted)), key, 'normalizing is idempotent');
			}
		});
	});

	describe('names what was sent instead of a private key', () => {
		it('an OpenSSH public key line, by its algorithm', () => {
			const blob = 'AAAAC3NzaC1lZDI1NTE5AAAAIGExampleExampleExampleExampleExampleExample';
			for (const [algorithm, key] of [
				['ssh-ed25519', `ssh-ed25519 ${blob} me@laptop`],
				['ssh-rsa', 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQExample user@host'],
				['ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYExample'],
				['sk-ssh-ed25519@openssh.com', 'sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tExample'],
				['ssh-ed25519-cert-v01@openssh.com', 'ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC1lZDI1NTE5LWNlcnQExample'],
				// an authorized_keys line with options, and a known_hosts line, still hold a public key
				['ssh-ed25519', `no-pty,command="deploy" ssh-ed25519 ${blob}`],
				['ssh-ed25519', `github.com ssh-ed25519 ${blob}`],
			]) {
				assert.equal(
					describeSSHPrivateKeyProblem(key),
					`The SSH key looks like a public key ("${algorithm} …"). ${PUBLIC_KEY_HINT}`
				);
			}
		});

		it('a public key in the PEM and RFC 4716 export formats', () => {
			const body = Buffer.alloc(300, 7);
			for (const key of [
				armor('PUBLIC KEY', body),
				armor('RSA PUBLIC KEY', body),
				['---- BEGIN SSH2 PUBLIC KEY ----', body.toString('base64'), '---- END SSH2 PUBLIC KEY ----'].join('\n'),
			]) {
				assert.equal(describeSSHPrivateKeyProblem(key), `The SSH key is a public key. ${PUBLIC_KEY_HINT}`);
			}
		});

		it('a PuTTY key', () => {
			const ppk = 'PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: me@laptop\nPublic-Lines: 2';
			assert.match(describeSSHPrivateKeyProblem(ppk), /^The SSH key is a PuTTY key \(\.ppk\)/);
		});

		it('an armored block that is no private key', () => {
			assert.equal(
				describeSSHPrivateKeyProblem(armor('CERTIFICATE', Buffer.alloc(300, 7))),
				'Expected an SSH private key, but found "-----BEGIN CERTIFICATE-----".'
			);
		});

		it('prose, a fingerprint, or a key body without its armor', () => {
			const body = keys['an OpenSSH Ed25519 key'].split('\n').slice(1, -2).join('\n');
			for (const key of ['my github deploy key', 'SHA256:k4F8irlPUWw4tsdm9YJLDfiq/Jcuz2BCEVe4k57F5f4', body]) {
				assert.match(describeSSHPrivateKeyProblem(key), /^The SSH key doesn't look like a private key\./);
			}
		});

		it('nothing at all', () => {
			assert.equal(describeSSHPrivateKeyProblem(' \n\t\r\n'), 'The SSH key is empty.');
		});

		it('far more text than any private key, without parsing it', () => {
			const key = keys['an OpenSSH Ed25519 key'].padEnd(MAX_SSH_PRIVATE_KEY_LENGTH + 1, '\n');
			assert.match(describeSSHPrivateKeyProblem(key), /^The SSH key is too long to be a private key/);
		});
	});

	describe('refuses the armor ssh reads wrongly', () => {
		it('text before an OpenSSH key, which OpenSSH reads only from the first line', () => {
			assert.equal(
				describeSSHPrivateKeyProblem(`ssh-ed25519 AAAAC3Nz me@laptop\n${keys['an OpenSSH Ed25519 key']}`),
				'The SSH key has text before "-----BEGIN OPENSSH PRIVATE KEY-----", and ssh reads this format only from the first line. Send only the private key.'
			);
		});

		it('a key missing its END line, or ending with another label', () => {
			const lines = keys['an OpenSSH Ed25519 key'].trimEnd().split('\n');
			const missing =
				'The SSH key is incomplete: its "-----END OPENSSH PRIVATE KEY-----" line is missing. Copy the whole file.';
			assert.equal(describeSSHPrivateKeyProblem(lines.slice(0, -1).join('\n')), missing);
			assert.equal(
				describeSSHPrivateKeyProblem([...lines.slice(0, -1), '-----END RSA PRIVATE KEY-----'].join('\n')),
				missing
			);
		});
	});

	describe('refuses a key ssh loads only with what Harper lacks', () => {
		it('a passphrase, for every format that has one', () => {
			const encrypted = generateKeyPairSync('rsa', {
				modulusLength: 2048,
				privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'correct horse' },
				publicKeyEncoding: { type: 'spki', format: 'pem' },
			}).privateKey;
			const legacyPEM = generateKeyPairSync('rsa', {
				modulusLength: 2048,
				privateKeyEncoding: { type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'correct horse' },
				publicKeyEncoding: { type: 'spki', format: 'pem' },
			}).privateKey;
			assert.match(legacyPEM, /Proc-Type: 4,ENCRYPTED/);
			for (const key of [
				encrypted,
				legacyPEM,
				openSSHPrivateKey({ cipherName: 'aes256-ctr' }),
				openSSHPrivateKey({ cipherName: 'chacha20-poly1305@openssh.com' }),
				// the `none` cipher behind a KDF still asks for a passphrase
				openSSHPrivateKey({ cipherName: 'none', kdfName: 'bcrypt' }),
			]) {
				assert.match(describeSSHPrivateKeyProblem(key), new RegExp(`^${PASSPHRASE}`));
			}
		});

		it('a hardware security key (FIDO)', () => {
			for (const keyType of ['sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com']) {
				const key = openSSHPrivateKey({
					keyType,
					fields: { publicFields: sshString('x'), privateFields: sshString('x') },
				});
				assert.match(describeSSHPrivateKeyProblem(key), new RegExp(`^${FIDO}`));
			}
		});
	});

	describe('refuses a key type ssh has dropped or never supported', () => {
		it('DSA, in every format', () => {
			const dsa = { modulusLength: 1024, divisorLength: 160 };
			for (const key of [
				pemPrivateKey('dsa', 'pkcs8', dsa),
				armor('DSA PRIVATE KEY', Buffer.alloc(300, 7)),
				openSSHPrivateKey({
					keyType: 'ssh-dss',
					fields: { publicFields: sshString('x'), privateFields: sshString('x') },
				}),
			]) {
				assert.match(describeSSHPrivateKeyProblem(key), new RegExp(`^${DSA}`));
			}
		});

		it('an RSA key under 1024 bits, in either format', () => {
			const expected = /^The SSH key is a 1000-bit RSA key, and ssh requires at least 1024 bits\./;
			assert.match(describeSSHPrivateKeyProblem(pemPrivateKey('rsa', 'pkcs8', { modulusLength: 1000 })), expected);
			const fields = openSSHKeyFields('ssh-rsa', { bits: 1000 });
			assert.match(describeSSHPrivateKeyProblem(openSSHPrivateKey({ keyType: 'ssh-rsa', fields })), expected);
		});

		it('curves and key types OpenSSH has no support for, by name', () => {
			for (const [key, name] of [
				[pemPrivateKey('ec', 'sec1', { namedCurve: 'secp256k1' }), 'curve (secp256k1)'],
				[pemPrivateKey('x25519', 'pkcs8'), 'type (x25519)'],
				[pemPrivateKey('ed448', 'pkcs8'), 'type (ed448)'],
				[pemPrivateKey('rsa-pss', 'pkcs8', { modulusLength: 2048 }), 'type (rsa-pss)'],
				[
					openSSHPrivateKey({
						keyType: 'ssh-xmss@openssh.com',
						fields: { publicFields: sshString('x'), privateFields: sshString('x') },
					}),
					'type (ssh-xmss@openssh.com)',
				],
			]) {
				assert.equal(
					describeSSHPrivateKeyProblem(key),
					`The SSH key's ${name} ${UNSUPPORTED}. Use an Ed25519, ECDSA or RSA key — for example, a new deploy key from ssh-keygen -t ed25519 -N "".`
				);
			}
		});
	});

	describe('refuses a damaged body', () => {
		// P-256 fields for private scalar `d` (a fresh key's by default), its point passed through `encode`
		const ecdsaFields = (encode, d) => {
			const ecdh = createECDH('prime256v1');
			if (d) ecdh.setPrivateKey(Buffer.concat([Buffer.alloc(32 - d.length), d]));
			else ecdh.generateKeys();
			const curve = sshString('nistp256');
			const point = sshString(encode(ecdh.getPublicKey()));
			return {
				publicFields: Buffer.concat([curve, point]),
				privateFields: Buffer.concat([curve, point, mpint(ecdh.getPrivateKey())]),
			};
		};
		const withBody = (key, edit) => {
			const lines = key.trimEnd().split('\n');
			return [lines[0], ...edit(lines.slice(1, -1)), lines.at(-1)].join('\n') + '\n';
		};

		it('a line lost, doubled, or cut short, in either format', () => {
			for (const key of [keys['an OpenSSH RSA key'], keys['a PKCS#1 RSA key'], keys['a SEC1 EC P-521 key']]) {
				for (const edit of [
					(body) => [...body.slice(0, 2), ...body.slice(3)],
					(body) => [...body.slice(0, 3), ...body.slice(2)],
					(body) => body.slice(0, -1),
				]) {
					assert.equal(describeSSHPrivateKeyProblem(withBody(key, edit)), DAMAGED);
				}
			}
		});

		it('characters that are not base64, including lookalikes a paste can bring in', () => {
			const openSSH = keys['an OpenSSH Ed25519 key'];
			for (const insert of ['*', '\u00A0', '\uFEFF', '“']) {
				assert.equal(
					describeSSHPrivateKeyProblem(
						withBody(openSSH, (body) => [`${body[0].slice(0, 8)}${insert}${body[0].slice(8)}`, ...body.slice(1)])
					),
					DAMAGED
				);
			}
			assert.equal(describeSSHPrivateKeyProblem(armor(OPENSSH_LABEL, Buffer.alloc(0))), DAMAGED);
		});

		it("a body missing its final base64 padding, which both of ssh's decoders refuse", () => {
			const pem = pemPrivateKey('ec', 'sec1', { namedCurve: 'P-256' });
			// the 8-byte padding absorbs small changes, so walk the comment through a few blocks
			const openSSH = Array.from({ length: 24 }, (_, length) =>
				openSSHPrivateKey({ comment: 'c'.repeat(length + 1) })
			).find((key) => /=\n-----END/.test(key));
			for (const key of [pem, openSSH]) {
				assert.match(key, /=\n-----END/);
				assert.equal(describeSSHPrivateKeyProblem(key.replace(/=+\n(-----END)/, '\n$1')), DAMAGED);
			}
		});

		it('a PEM body whose outer length is right but holds no key (an empty SEQUENCE)', () => {
			assert.equal(
				describeSSHPrivateKeyProblem('-----BEGIN RSA PRIVATE KEY-----\nMAA=\n-----END RSA PRIVATE KEY-----\n'),
				DAMAGED
			);
		});

		it('an OpenSSH private section holding only its check integers and padding', () => {
			const key = openSSHPrivateKey({ privateSection: padTo(Buffer.concat([uint32(7), uint32(7)])) });
			assert.equal(describeSSHPrivateKeyProblem(key), DAMAGED);
		});

		it('an OpenSSH container that breaks any of the rules OpenSSH loads it by', () => {
			const ed25519 = openSSHKeyFields('ssh-ed25519');
			const rsa = openSSHKeyFields('ssh-rsa');
			const otherEd25519 = openSSHKeyFields('ssh-ed25519');
			const damaged = {
				'no magic': Buffer.concat([Buffer.from('openssh-key-v2\0'), openSSHKeyBytes().subarray(15)]),
				'two keys': openSSHKeyBytes({ keyCount: 2 }),
				'an empty public key': openSSHKeyBytes({ publicBlob: Buffer.alloc(0) }),
				'bytes after the public key fields': openSSHKeyBytes({
					publicBlob: Buffer.concat([sshString('ssh-ed25519'), ed25519.publicFields, Buffer.from([0])]),
					fields: ed25519,
				}),
				'a cipher without a KDF': openSSHKeyBytes({ cipherName: 'aes256-ctr', kdfName: 'none' }),
				'check integers that differ': openSSHKeyBytes({ checkInts: [1, 2] }),
				'a private section not in whole 8-byte blocks': openSSHKeyBytes({
					privateSection: Buffer.concat([
						uint32(1),
						uint32(1),
						sshString('ssh-ed25519'),
						ed25519.privateFields,
						sshString('c'),
					]),
					fields: ed25519,
				}),
				'bytes after the private section': openSSHKeyBytes({ trailing: Buffer.from('extra') }),
				'a private key of another type': openSSHKeyBytes({ privateKeyType: 'ssh-rsa' }),
				'a private key that is not the public key': openSSHKeyBytes({
					fields: ed25519,
					privateFields: otherEd25519.privateFields,
				}),
				'an RSA private key that is not the public key': openSSHKeyBytes({
					keyType: 'ssh-rsa',
					fields: rsa,
					privateFields: openSSHKeyFields('ssh-rsa').privateFields,
				}),
				'a zero RSA prime': openSSHKeyBytes({
					keyType: 'ssh-rsa',
					fields: openSSHKeyFields('ssh-rsa', { rsaPrivate: { q: Buffer.alloc(0) } }),
				}),
				// the same field in both halves, so only the rule under test can refuse it
				'a negative RSA modulus': openSSHKeyBytes({
					keyType: 'ssh-rsa',
					fields: {
						publicFields: Buffer.concat([mpint(Buffer.from([1, 0, 1])), sshString(Buffer.alloc(256, 0xff))]),
						privateFields: Buffer.concat([
							sshString(Buffer.alloc(256, 0xff)),
							mpint(Buffer.from([1, 0, 1])),
							...Array.from({ length: 4 }, () => mpint(Buffer.alloc(128, 1))),
						]),
					},
				}),
				'an Ed25519 public key of the wrong size': openSSHKeyBytes({
					publicBlob: Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.alloc(31, 1))]),
				}),
				'an ECDSA point off its curve': openSSHKeyBytes({
					keyType: 'ecdsa-sha2-nistp256',
					fields: {
						publicFields: Buffer.concat([
							sshString('nistp256'),
							sshString(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)])),
						]),
						privateFields: Buffer.concat([
							sshString('nistp256'),
							sshString(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)])),
							mpint(Buffer.alloc(32, 1)),
						]),
					},
				}),
				'an ECDSA key naming another curve': openSSHKeyBytes({
					keyType: 'ecdsa-sha2-nistp256',
					fields: openSSHKeyFields('ecdsa-sha2-nistp384'),
				}),
				'padding that is not 1, 2, 3…': openSSHKeyBytes({
					privateSection: Buffer.concat([
						uint32(1),
						uint32(1),
						sshString('ssh-ed25519'),
						ed25519.privateFields,
						sshString('c'),
						Buffer.alloc(8 - ((8 + 15 + ed25519.privateFields.length + 5) % 8), 9),
					]),
					fields: ed25519,
				}),
				// a NUL is allowed only as a string's last byte (`sshbuf_get_cstring`)
				'a NUL inside its comment': openSSHKeyBytes({ comment: 'a\0b' }),
				'an ECDSA point in compressed form': openSSHKeyBytes({
					keyType: 'ecdsa-sha2-nistp256',
					fields: ecdsaFields((point) => ECDH.convertKey(point, 'prime256v1', undefined, undefined, 'compressed')),
				}),
				// the same length as an uncompressed point, but a prefix OpenSSH doesn't read
				'an ECDSA point in hybrid form': openSSHKeyBytes({
					keyType: 'ecdsa-sha2-nistp256',
					fields: ecdsaFields((point) => Buffer.concat([Buffer.from([6 + (point[64] & 1)]), point.subarray(1)])),
				}),
				"an ECDSA private scalar of half the order's bits or fewer": openSSHKeyBytes({
					keyType: 'ecdsa-sha2-nistp256',
					fields: ecdsaFields((point) => point, Buffer.from([1])),
				}),
				'an RSA prime of 1': openSSHKeyBytes({
					keyType: 'ssh-rsa',
					fields: openSSHKeyFields('ssh-rsa', { rsaPrivate: { p: Buffer.from([1]) } }),
				}),
				'an Ed25519 secret key whose second half is not the public key': openSSHKeyBytes({
					fields: {
						publicFields: ed25519.publicFields,
						privateFields: Buffer.concat([
							ed25519.publicFields,
							sshString(Buffer.concat([ed25519.privateFields.subarray(40, 72), otherEd25519.publicFields.subarray(4)])),
						]),
					},
				}),
				'a key type field that is not a name': openSSHKeyBytes({
					publicBlob: Buffer.concat([sshString('ssh-ed2\x015519'), ed25519.publicFields]),
				}),
			};
			for (const [what, bytes] of Object.entries(damaged)) {
				assert.equal(describeSSHPrivateKeyProblem(armor(OPENSSH_LABEL, bytes)), DAMAGED, what);
			}
		});

		it('an OpenSSH body cut at any byte, without ever throwing', () => {
			const bytes = openSSHKeyBytes({ keyType: 'ecdsa-sha2-nistp256' });
			for (let length = 0; length < bytes.length; length++) {
				assert.equal(
					describeSSHPrivateKeyProblem(armor(OPENSSH_LABEL, bytes.subarray(0, length))),
					DAMAGED,
					`cut at ${length}`
				);
			}
		});

		it('a certificate key only by its container, which is all that is parsed of one', () => {
			const certificate = { publicFields: sshString('opaque'), privateFields: sshString('opaque') };
			const keyType = 'ssh-ed25519-cert-v01@openssh.com';
			assert.equal(describeSSHPrivateKeyProblem(openSSHPrivateKey({ keyType, fields: certificate })), undefined);
			assert.equal(
				describeSSHPrivateKeyProblem(openSSHPrivateKey({ keyType, fields: certificate, checkInts: [1, 2] })),
				DAMAGED
			);
		});
	});

	describe('refuses a key that loads but cannot sign for its public key', () => {
		// ssh presents the public key, so a private key that doesn't match it can never authenticate
		const mismatched = () => {
			const ed25519 = openSSHKeyFields('ssh-ed25519');
			const otherEd25519 = openSSHKeyFields('ssh-ed25519');
			const [rsa, otherRSA] = [openSSHKeyFields('ssh-rsa'), openSSHKeyFields('ssh-rsa')];
			const [ecdsa, otherECDSA] = [openSSHKeyFields('ecdsa-sha2-nistp256'), openSSHKeyFields('ecdsa-sha2-nistp256')];
			// an RSA private section opens with its copy of n and e
			const rsaPublicCopy = (fields) => 8 + fields.readUInt32BE(0) + fields.readUInt32BE(4 + fields.readUInt32BE(0));
			const [own, other] = [0, 1].map(() =>
				generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' })
			);
			return {
				"an OpenSSH Ed25519 key whose seed is another key's": openSSHPrivateKey({
					fields: {
						publicFields: ed25519.publicFields,
						privateFields: Buffer.concat([
							ed25519.publicFields,
							sshString(Buffer.concat([otherEd25519.privateFields.subarray(40, 72), ed25519.publicFields.subarray(4)])),
						]),
					},
				}),
				"an OpenSSH RSA key whose private components are another key's": openSSHPrivateKey({
					keyType: 'ssh-rsa',
					fields: {
						publicFields: rsa.publicFields,
						privateFields: Buffer.concat([
							rsa.privateFields.subarray(0, rsaPublicCopy(rsa.privateFields)),
							otherRSA.privateFields.subarray(rsaPublicCopy(otherRSA.privateFields)),
						]),
					},
				}),
				"an OpenSSH ECDSA key whose private scalar is another key's": openSSHPrivateKey({
					keyType: 'ecdsa-sha2-nistp256',
					fields: {
						publicFields: ecdsa.publicFields,
						privateFields: Buffer.concat([
							ecdsa.publicFields,
							otherECDSA.privateFields.subarray(otherECDSA.publicFields.length),
						]),
					},
				}),
				"a SEC1 EC key whose embedded public key is another key's": createPrivateKey({
					key: { ...other, d: own.d },
					format: 'jwk',
				}).export({ type: 'sec1', format: 'pem' }),
			};
		};

		it('refuses each as damaged', () => {
			for (const [what, key] of Object.entries(mismatched()))
				assert.equal(describeSSHPrivateKeyProblem(key), DAMAGED, what);
		});

		it('though ssh-keygen loads each — loading never checks the pair — and then cannot sign with it', function () {
			if (!hasSSHKeygen) this.skip();
			for (const [what, key] of Object.entries(mismatched())) {
				assert.ok(sshKeygenLoads(key), what);
				assert.ok(!sshKeygenSigns(key), what);
			}
		});
	});

	describe('refuses what OpenSSH refuses on load though the key could sign', () => {
		const refusedOnLoad = () => {
			const ecdsa = openSSHKeyFields('ecdsa-sha2-nistp256');
			const other = openSSHKeyFields('ecdsa-sha2-nistp256');
			const { n, e, d, p, q, qi } = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
				format: 'jwk',
			});
			const bytes = (value) => Buffer.from(value, 'base64url');
			// a modulus written without the leading zero byte that keeps its high bit from reading as a sign
			const unsignedModulus = sshString(bytes(n));
			const smallScalar = createECDH('prime256v1');
			smallScalar.setPrivateKey(Buffer.concat([Buffer.alloc(31), Buffer.from([1])]));
			const point = smallScalar.getPublicKey();
			return {
				"an OpenSSH ECDSA key whose private section's copy of the public point is another key's": openSSHPrivateKey({
					keyType: 'ecdsa-sha2-nistp256',
					fields: {
						publicFields: ecdsa.publicFields,
						privateFields: Buffer.concat([other.publicFields, ecdsa.privateFields.subarray(ecdsa.publicFields.length)]),
					},
				}),
				'an OpenSSH RSA key whose modulus reads as negative': openSSHPrivateKey({
					keyType: 'ssh-rsa',
					fields: {
						publicFields: Buffer.concat([mpint(bytes(e)), unsignedModulus]),
						privateFields: Buffer.concat([
							unsignedModulus,
							mpint(bytes(e)),
							...[d, qi, p, q].map((value) => mpint(bytes(value))),
						]),
					},
				}),
				"a SEC1 EC key whose private scalar has half the order's bits or fewer": createPrivateKey({
					key: {
						kty: 'EC',
						crv: 'P-256',
						x: point.subarray(1, 33).toString('base64url'),
						y: point.subarray(33).toString('base64url'),
						d: smallScalar.getPrivateKey().toString('base64url'),
					},
					format: 'jwk',
				}).export({ type: 'sec1', format: 'pem' }),
			};
		};

		it('refuses each as damaged', () => {
			for (const [what, key] of Object.entries(refusedOnLoad()))
				assert.equal(describeSSHPrivateKeyProblem(key), DAMAGED, what);
		});

		it('as ssh-keygen does', function () {
			if (!hasSSHKeygen) this.skip();
			for (const [what, key] of Object.entries(refusedOnLoad())) assert.ok(!sshKeygenLoads(key), what);
		});
	});

	describe('against the real ssh-keygen', () => {
		before(function () {
			if (!hasSSHKeygen) this.skip();
		});

		it('loads and signs with every key the fixtures build, so the acceptances above are of real keys', () => {
			for (const [kind, key] of Object.entries(keys)) assert.ok(sshKeygenSigns(key), kind);
		});

		it('agrees with it on whether a pasted key can sign once stored normalized, for each way a paste goes wrong', function () {
			this.timeout(60000);
			const mutations = {
				'as generated': (key) => key,
				'without its final newline': (key) => key.trimEnd(),
				'with CRLF line endings': (key) => key.replace(/\n/g, '\r\n'),
				'indented': (key) => key.replace(/^(?=.)/gm, '    '),
				'with trailing spaces': (key) => key.replace(/(?<=.)$/gm, '  '),
				'double-spaced': (key) => key.replace(/\n/g, '\n\n'),
				'after a line of text': (key) => `my deploy key:\n${key}`,
				'before a line of text': (key) => `${key}that was the key\n`,
				'with a body line lost': (key) => key.replace(/\n[A-Za-z0-9+/=]+\n/, '\n'),
				'with a body line doubled': (key) => key.replace(/\n([A-Za-z0-9+/=]+)\n/, '\n$1\n$1\n'),
				'with its END line cut off': (key) => key.trimEnd().split('\n').slice(0, -1).join('\n') + '\n',
				'without its final padding': (key) => key.replace(/=+\n(-----END)/, '\n$1'),
				'with a character changed': (key) => {
					const lines = key.split('\n');
					lines[3] = lines[3].slice(0, 20) + (lines[3][20] === 'A' ? 'B' : 'A') + lines[3].slice(21);
					return lines.join('\n');
				},
			};
			const disagreements = [];
			for (const [kind, key] of Object.entries(keys)) {
				for (const [how, mutate] of Object.entries(mutations)) {
					const pasted = mutate(key);
					const accepted = describeSSHPrivateKeyProblem(pasted) === undefined;
					if (accepted !== sshKeygenSigns(normalizeSSHPrivateKey(pasted))) {
						disagreements.push(`${kind} ${how}: validator ${accepted ? 'accepts' : 'refuses'}`);
					}
				}
			}
			assert.deepEqual(disagreements, []);
		});

		it('agrees on the key types ssh refuses outright', () => {
			for (const key of [
				pemPrivateKey('rsa', 'pkcs1', { modulusLength: 1000 }),
				pemPrivateKey('ec', 'sec1', { namedCurve: 'secp256k1' }),
				pemPrivateKey('x25519', 'pkcs8'),
				pemPrivateKey('rsa-pss', 'pkcs8', { modulusLength: 2048 }),
				'-----BEGIN RSA PRIVATE KEY-----\nMAA=\n-----END RSA PRIVATE KEY-----\n',
				openSSHPrivateKey({ privateSection: padTo(Buffer.concat([uint32(7), uint32(7)])) }),
			]) {
				assert.ok(!sshKeygenLoads(key));
				assert.notEqual(describeSSHPrivateKeyProblem(key), undefined);
			}
		});
	});
});

describe('SSH config value validation', () => {
	let describeSSHConfigValueProblem;

	before(async function () {
		this.timeout(60000);
		({ describeSSHConfigValueProblem } = await import('#src/security/sshKeyValidation'));
	});

	const accepted = [
		'my-repo.github.com',
		'github.com',
		'gh_1',
		'10.0.0.1',
		'::1',
		'fe80::1%en0',
		'%h.example.com',
		'a,b',
		'git#lab.com',
	];
	// a HostName is never matched against, so only an alias can't be a pattern
	const acceptedAsHostname = ['*.example.org', 'repo?.example.org'];
	const refused = {
		'a b': 'must be a single',
		'a\tb': 'must be a single',
		'a\nProxyCommand evil': 'must be a single',
		'a\u00A0b': 'must be a single',
		'a\u0000b': 'must be a single',
		'a"b': 'must not contain quotes',
		"a'b": 'must not contain quotes',
		'"github.com"': 'must not contain quotes',
		'=': 'must not contain quotes or "="',
		'=#x': 'must not contain quotes or "="',
		// OpenSSH before 8.7 splits an argument at "=", making this two
		'example.com=extra': 'must not contain quotes or "="',
		'-oProxyCommand': 'must not start with "-"',
		'#github.com': 'must not start with "#"',
	};
	const refusedAsHost = ['*', '*.github.com', 'repo?.github.com', '!github.com'];

	it('accepts any alias or hostname ssh reads as one argument', () => {
		for (const value of accepted) {
			for (const field of ['host', 'hostname'])
				assert.equal(describeSSHConfigValueProblem(field, value), undefined, `${field} ${value}`);
		}
		for (const value of acceptedAsHostname)
			assert.equal(describeSSHConfigValueProblem('hostname', value), undefined, value);
	});

	it("refuses an alias that is a pattern, since its block would also apply to other keys' aliases", () => {
		for (const value of refusedAsHost) {
			assert.equal(
				describeSSHConfigValueProblem('host', value),
				`'host' must be one alias, not a pattern: "*", "?" and "!" also match other keys' aliases; got ${JSON.stringify(value)}.`
			);
		}
	});

	it('accepts every character Studio accepts, wherever Studio accepts it', () => {
		const studioAllows = /^(?!-)[A-Za-z0-9._-]+$/;
		for (const character of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-') {
			for (const value of [character, `${character}x`, `x${character}`, `x${character}x`]) {
				if (!studioAllows.test(value)) continue;
				for (const field of ['host', 'hostname'])
					assert.equal(describeSSHConfigValueProblem(field, value), undefined, value);
			}
		}
	});

	it('refuses each value that breaks the config or can never connect, naming the field and value', () => {
		for (const [value, reason] of Object.entries(refused)) {
			const problem = describeSSHConfigValueProblem('hostname', value);
			assert.ok(problem?.startsWith("'hostname' ") && problem.includes(reason), `${JSON.stringify(value)}: ${problem}`);
			assert.ok(problem.endsWith(`got ${JSON.stringify(value)}.`), problem);
		}
		assert.equal(describeSSHConfigValueProblem('host', ''), "'host' must not be empty.");
	});

	describe('against the real ssh', () => {
		let dir;

		before(function () {
			if (!hasSSH) this.skip();
			dir = mkdtempSync(join(tmpdir(), 'ssh-config-oracle-'));
		});

		after(() => {
			if (dir) rmSync(dir, { recursive: true, force: true });
		});

		// the block add_ssh_key writes, beside another key's — before it or after it, since keys are
		// appended in the order they are added and ssh takes each option from the first block that matches
		const resolvesOtherKey = (host, hostname, { newBlockFirst = false } = {}) => {
			const config = join(dir, 'config');
			const block = (name, blockHost, blockHostname) =>
				`#${name}\nHost ${blockHost}\n\tHostName ${blockHostname}\n\tUser git\n\tIdentityFile /nonexistent/${name}.key\n\tIdentitiesOnly yes`;
			const blocks = [block('other', 'other.example.com', 'github.com'), block('new', host, hostname)];
			writeFileSync(config, (newBlockFirst ? blocks.reverse() : blocks).join('\n'));
			try {
				return execFileSync('ssh', ['-G', '-F', config, 'other.example.com'], { stdio: ['ignore', 'pipe', 'ignore'] })
					.toString()
					.includes('hostname github.com\n');
			} catch {
				return false;
			}
		};

		it('leaves every other key resolvable for every value accepted here, in either order', () => {
			for (const newBlockFirst of [false, true]) {
				for (const value of accepted) {
					assert.ok(resolvesOtherKey(value, 'gitlab.com', { newBlockFirst }), `Host ${value}`);
					assert.ok(resolvesOtherKey('new.example.com', value, { newBlockFirst }), `HostName ${value}`);
				}
				for (const value of acceptedAsHostname) {
					assert.ok(resolvesOtherKey('new.example.com', value, { newBlockFirst }), `HostName ${value}`);
				}
			}
		});

		it('breaks every other key for the values refused for that reason', () => {
			for (const value of ['a b', 'a"b', "a'b", '#github.com', '=', '=#x']) {
				assert.ok(!resolvesOtherKey('new.example.com', value), `HostName ${JSON.stringify(value)}`);
			}
		});

		it('sends the other key to the wrong host when a pattern alias comes first', () => {
			for (const value of ['*', '*.example.com', 'other.example.co?']) {
				assert.ok(!resolvesOtherKey(value, 'gitlab.com', { newBlockFirst: true }), `Host ${value}`);
			}
		});
	});
});
