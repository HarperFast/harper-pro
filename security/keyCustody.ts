/**
 * KeyCustody — who holds the env-secrets private key, and where the private-key operation runs.
 *
 * The interface exposes only an **unwrap** operation (RSA-OAEP unwrap of a hybrid envelope's AES
 * key), never the private key itself. The custody instance lives in *host scope* — the trusted side
 * of Harper's module-loader sandbox — and customer code reaches it only through the mediated,
 * per-component accessor (secretsAccessor.ts). Since Harper runs component/plugin code in `node:vm`
 * contexts (hardened by SES / frozen intrinsics) and controls what those contexts can reference,
 * keeping the custody object off the sandbox global / `harper` exports is what isolates the key from
 * a compromised plugin or an SSR JS-RCE. That is the threat this design targets, and the default
 * FileKeyCustody handles it — no separate process required.
 *
 *   - FileKeyCustody  — RSA-4096 keypair on disk, loaded into the trusted process, held in host
 *                       scope. The default. Provides a sync unwrap for the legacy loadEnv path.
 *   - KmsKeyCustody   — OPTIONAL off-box tier: key lives in AWS KMS and never enters the process;
 *                       `unwrapKey` is a KMS.Decrypt (auditable/rate-limitable/revocable). Only this
 *                       (or an HSM) additionally resists *host-root* / native-RCE compromise — a
 *                       higher bar than the JS-compromise threat above — at the cost of a third party.
 *   - (future)        — PKCS#11 / TPM "local HSM", or cluster threshold key-shares (no single node
 *                       holds the whole key). Same interface throughout.
 */
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprintOf, openEnvelope, parseEnvelope, unwrapWithPrivateKey } from './envSecretCrypto.ts';

export interface KeyCustody {
	/** The active key's `kid` (SHA-256 of its DER SPKI public key) — for envelope targeting/rotation. */
	keyId(): Promise<string>;
	/** SPKI PEM public key clients encrypt against. Public material — safe to expose. */
	publicKey(): Promise<string>;
	/** Unwrap an envelope's RSA-OAEP(SHA-256)-wrapped AES key. The private key stays in the backend. */
	unwrapKey(wrappedKey: Buffer): Promise<Buffer>;
}

const PRIVATE_KEY_FILE = 'envSecrets.private.pem';
const PUBLIC_KEY_FILE = 'envSecrets.public.pem';

/**
 * File-backed custody: an RSA-4096 keypair in the keys/ dir, loaded into the trusted process. The
 * key is cluster-shared — the leader generates it and it's cloned to new nodes (cloneEnvSecretsKeys).
 */
export class FileKeyCustody implements KeyCustody {
	readonly #dir: string;
	#privatePem?: string;
	#publicPem?: string;
	#fingerprint?: string;

	constructor(dir: string) {
		this.#dir = dir;
	}

	/** Whether the key file exists yet (workers use this to decide before touching the key). */
	hasKey(): boolean {
		return existsSync(join(this.#dir, PRIVATE_KEY_FILE));
	}

	/**
	 * Generate the shared keypair if absent, then load it. Idempotent. Generation is EXPLICIT and
	 * belongs only to the leader / main thread — a worker calling this could fork a divergent keypair,
	 * so workers must not. Kept separate from the accessors (which are load-only and throw if the key
	 * is absent) so the leader's create step can't be silently skipped by call ordering.
	 */
	ensureKey(): void {
		if (this.#privatePem || this.hasKey()) {
			this.#ensureLoaded();
			return;
		}
		const { privateKey, publicKey } = generateKeyPairSync('rsa', {
			modulusLength: 4096,
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		});
		mkdirSync(this.#dir, { recursive: true });
		writeFileSync(join(this.#dir, PRIVATE_KEY_FILE), privateKey as string, { mode: 0o600 });
		writeFileSync(join(this.#dir, PUBLIC_KEY_FILE), publicKey as string, { mode: 0o644 });
		this.#privatePem = privateKey as string;
		this.#publicPem = createPublicKey(this.#privatePem).export({ type: 'spki', format: 'pem' }) as string;
		this.#fingerprint = fingerprintOf(this.#publicPem);
	}

	#ensureLoaded(): void {
		if (this.#privatePem) return;
		const privatePath = join(this.#dir, PRIVATE_KEY_FILE);
		if (!existsSync(privatePath)) {
			throw new Error('env-secrets keypair is not available on this node');
		}
		this.#privatePem = readFileSync(privatePath, 'utf8');
		this.#publicPem = createPublicKey(this.#privatePem).export({ type: 'spki', format: 'pem' }) as string;
		this.#fingerprint = fingerprintOf(this.#publicPem);
	}

	async keyId(): Promise<string> {
		return this.keyIdSync();
	}
	async publicKey(): Promise<string> {
		return this.publicKeySync();
	}
	async unwrapKey(wrappedKey: Buffer): Promise<Buffer> {
		return this.unwrapKeySync(wrappedKey);
	}

	// Sync accessors for the legacy loadEnv → process.env injection path (file backend only; KMS
	// custody is async-only and must be used via the accessor).
	keyIdSync(): string {
		this.#ensureLoaded();
		return this.#fingerprint!;
	}
	publicKeySync(): string {
		this.#ensureLoaded();
		return this.#publicPem!;
	}
	unwrapKeySync(wrappedKey: Buffer): Buffer {
		this.#ensureLoaded();
		return unwrapWithPrivateKey(wrappedKey, this.#privatePem!);
	}

	/**
	 * File-backend-only: the raw private key, solely for the `get_key` clone path that copies the
	 * shared key to new nodes. No other caller should use this. KMS/HSM custody has no equivalent —
	 * every node references the same cloud key, so there is nothing to clone.
	 */
	exportPrivateKeyPemForCloning(): string {
		this.#ensureLoaded();
		return this.#privatePem!;
	}
}

/**
 * KMS-backed custody (sketch). The private key lives in AWS KMS and never enters this process;
 * `unwrapKey` is a KMS.Decrypt call. Requires `@aws-sdk/client-kms` and an asymmetric (RSA) KMS key
 * configured for ENCRYPT_DECRYPT with RSAES_OAEP_SHA_256.
 */
export class KmsKeyCustody implements KeyCustody {
	readonly #keyArn: string;
	readonly #region?: string;
	#publicPem?: string;
	#fingerprint?: string;

	constructor(opts: { keyArn: string; region?: string }) {
		this.#keyArn = opts.keyArn;
		this.#region = opts.region;
	}

	// Variable specifier so this compiles without the optional dependency installed.
	async #kms(): Promise<any> {
		const pkg = '@aws-sdk/client-kms';
		const { KMSClient } = await import(pkg);
		return new KMSClient({ region: this.#region });
	}

	async publicKey(): Promise<string> {
		if (this.#publicPem) return this.#publicPem;
		const pkg = '@aws-sdk/client-kms';
		const { GetPublicKeyCommand } = await import(pkg);
		const res = await (await this.#kms()).send(new GetPublicKeyCommand({ KeyId: this.#keyArn }));
		const der = Buffer.from(res.PublicKey as Uint8Array).toString('base64');
		this.#publicPem = `-----BEGIN PUBLIC KEY-----\n${der.replace(/(.{64})/g, '$1\n')}\n-----END PUBLIC KEY-----\n`;
		this.#fingerprint = fingerprintOf(this.#publicPem);
		return this.#publicPem;
	}

	async keyId(): Promise<string> {
		if (!this.#fingerprint) await this.publicKey();
		return this.#fingerprint!;
	}

	async unwrapKey(wrappedKey: Buffer): Promise<Buffer> {
		const pkg = '@aws-sdk/client-kms';
		const { DecryptCommand } = await import(pkg);
		const res = await (
			await this.#kms()
		).send(
			new DecryptCommand({
				KeyId: this.#keyArn,
				EncryptionAlgorithm: 'RSAES_OAEP_SHA_256',
				CiphertextBlob: wrappedKey,
			})
		);
		return Buffer.from(res.Plaintext as Uint8Array);
	}
}

export interface KeyCustodyConfig {
	backend?: 'file' | 'kms';
	dir?: string;
	kms?: { keyArn: string; region?: string };
}

/**
 * Select the custody backend from config. Defaults to file. Key generation is NOT a construction
 * concern — the leader calls `FileKeyCustody.ensureKey()` explicitly (see envSecrets.startOnMainThread).
 */
export function getKeyCustody(config: KeyCustodyConfig): KeyCustody {
	if (config.backend === 'kms') {
		if (!config.kms?.keyArn) throw new Error('kms key custody requires kms.keyArn');
		return new KmsKeyCustody(config.kms);
	}
	if (!config.dir) throw new Error('file key custody requires a keys directory');
	return new FileKeyCustody(config.dir);
}

/**
 * Decrypt an `enc:v1:` envelope body via any custody backend (async — supports KMS/HSM). The
 * private-key unwrap runs inside the backend; the ephemeral AES key and the plaintext exist only in
 * the trusted process, briefly. Throws on malformed input, a `kid` mismatch, or a tampered envelope.
 */
export async function decryptEnvelopeWithCustody(body: string, custody: KeyCustody): Promise<string> {
	const env = parseEnvelope(body);
	if (env.kid && env.kid !== (await custody.keyId())) {
		throw new Error(`no env-secrets key for kid ${env.kid}`);
	}
	return openEnvelope(env, await custody.unwrapKey(env.k));
}
