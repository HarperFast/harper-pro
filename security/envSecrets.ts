/**
 * Env-secret encryption (Pro). Fills the dormant decrypt hook that Harper core exposes
 * (`core/resources/envSecretDecryptor.ts`) so `.env` values written as `enc:v1:` envelopes are
 * decrypted at runtime. The private key is held by a KeyCustody backend and lives in *host scope* —
 * the trusted side of Harper's module-loader sandbox — never on a component's global or in the
 * `harper` module it can import. Harper runs customer code in `node:vm` contexts (hardened by SES /
 * frozen intrinsics) within the worker, so keeping the key out of that reachable graph is what
 * isolates it; no separate process is needed for the JS-compromise threat this targets.
 *
 * Two consumption paths:
 *   - loadEnv → `process.env` (legacy compat): synchronous (file backend sync unwrap). NOTE: `process`
 *     is reachable inside the sandbox, so anything here is ambient — fine for non-secret env, but it
 *     is the exposure the accessor below exists to avoid for real secrets.
 *   - `scope.secrets` (preferred / hardened): a per-component mediated accessor (see
 *     secretsAccessor.ts) that resolves only the keys a component declared in its `secrets:` config
 *     (secretsConfig.ts), decrypting on the trusted side. Nothing lands in `process.env`, so there's
 *     nothing ambient to scrape.
 *
 * Key model: a single cluster-shared keypair. The leader generates it and it's cloned to new nodes
 * (cloneEnvSecretsKeys → get_key).
 */
import { join } from 'node:path';
import { server } from '../core/server/Server.ts';
import { registerEnvSecretDecryptor } from '../core/resources/envSecretDecryptor.js';
import { ENV_ENCRYPTED_PREFIX } from '../core/utility/envFile.js';
import { getPrivateKeys } from '../core/security/keys.js';
import { getHdbBasePath } from '../core/utility/environment/environmentManager.js';
import { LICENSE_KEY_DIR_NAME } from '../core/utility/hdbTerms.js';
import { ClientError } from '../core/utility/errors/hdbError.js';
import logger from '../core/utility/logging/harper_logger.js';
import { openEnvelope, parseEnvelope } from './envSecretCrypto.ts';
import { decryptEnvelopeWithCustody, FileKeyCustody, getKeyCustody, type KeyCustody } from './keyCustody.ts';
import { type ComponentSecrets, createComponentSecrets } from './secretsAccessor.ts';
import type { SecretDeclaration } from './secretsConfig.ts';
import type { SecretsStore } from './secretsStore.ts';

// Also the name under which the private key is registered in core's key store, so the existing
// `get_key` operation can serve it to a cloning node (file backend only).
export const ENV_SECRETS_PRIVATE_KEY_NAME = 'envSecrets.private.pem';
const SCHEME = 'enc:v1';
const ALGORITHM = 'RSA-OAEP-SHA256 + AES-256-GCM';

let custody: KeyCustody | undefined;

// `generate` is passed true only from the main-thread entry point (the leader mints the shared key).
function getCustody(generate = false): KeyCustody {
	if (!custody) {
		// TODO(config): read `envSecrets.keyCustody` (file | kms) + kms settings from Harper config.
		custody = getKeyCustody({ backend: 'file', dir: join(getHdbBasePath(), LICENSE_KEY_DIR_NAME), generate });
	}
	return custody;
}

/** The file backend, when active — the sync loadEnv path and the get_key clone path need it. */
function fileCustody(generate = false): FileKeyCustody | undefined {
	const c = getCustody(generate);
	return c instanceof FileKeyCustody ? c : undefined;
}

/**
 * Synchronous decryptor for the loadEnv → `process.env` compat path. Requires the file backend
 * (sync unwrap). With KMS custody, `process.env` injection is unavailable — read via `scope.secrets`.
 */
function decryptEnvValue(value: string): string {
	const fc = fileCustody();
	if (!fc) {
		throw new Error(
			'process.env injection of encrypted values requires file key custody; with KMS custody, read secrets via scope.secrets'
		);
	}
	const env = parseEnvelope(value.slice(ENV_ENCRYPTED_PREFIX.length));
	if (env.kid && env.kid !== fc.keyIdSync()) {
		throw new Error(`no env-secrets key for kid ${env.kid}`);
	}
	return openEnvelope(env, fc.unwrapKeySync(env.k));
}

interface PublicKeyRequest {
	operation?: string;
}

/** `get_secrets_public_key` — returns only PUBLIC material clients use to encrypt secret values. */
async function getSecretsPublicKey(_req: PublicKeyRequest) {
	const c = getCustody();
	try {
		return { publicKey: await c.publicKey(), fingerprint: await c.keyId(), scheme: SCHEME, algorithm: ALGORITHM };
	} catch {
		throw new ClientError('env-secrets keypair is not initialized');
	}
}

/**
 * Build the per-component `scope.secrets` accessor. Authority is the trusted `store`
 * (secretsStore.ts): a read is allowed only if the secret's `grants` include `componentName` (which
 * Harper's loader asserts). Ciphertext comes from the store and is decrypted on demand via KeyCustody
 * — the private key stays in host scope, and plaintext is never written to `process.env`, so there is
 * nothing ambient for sandboxed code to scrape. `manifest` (the component's `secrets:` config) is
 * non-authoritative; it only drives `ensureRequired()` fail-fast and `describe()`.
 *
 * INTEGRATION (core loader): Harper builds this with the loader-asserted `componentName` and the
 * shared secrets store, binds it to the per-component `scope.secrets` (and `harper`'s `secrets`
 * export — never the shared sandbox global), passes the parsed `secrets:` manifest, and calls
 * `ensureRequired()` during load so a missing required secret fails the component loudly.
 */
export function createScopeSecrets(
	componentName: string,
	store: SecretsStore,
	opts: { manifest?: SecretDeclaration[] } = {}
): ComponentSecrets {
	const c = getCustody();
	return createComponentSecrets({
		componentName,
		store,
		manifest: opts.manifest,
		decrypt: (ciphertext) => decryptEnvelopeWithCustody(ciphertext.slice(ENV_ENCRYPTED_PREFIX.length), c),
		onAccess: ({ componentName: cn, name }) => logger.debug?.(`env-secret read: ${cn} -> ${name}`),
	});
}

/**
 * Main-thread entry point: ensure the shared keypair exists and expose the public key. The
 * operations API only runs on the main thread (v5.1+), so the operation registers here.
 */
export function startOnMainThread(): void {
	const fc = fileCustody(true); // leader mints the shared key if absent
	if (fc) {
		// Publish the shared private key so the `get_key` clone path can copy it to new nodes.
		getPrivateKeys().set(ENV_SECRETS_PRIVATE_KEY_NAME, fc.exportPrivateKeyPemForCloning());
	}
	registerEnvSecretDecryptor(decryptEnvValue);
	server.registerOperation?.({
		name: 'get_secrets_public_key',
		execute: getSecretsPublicKey,
		httpMethod: 'GET',
	});
}

/**
 * Worker-thread entry point: register the sync decryptor if the shared key is present (written by
 * the leader / cloned at bootstrap). Workers never generate the key.
 */
export function start(): void {
	const fc = fileCustody(false);
	if (fc && fc.hasKey()) {
		getPrivateKeys().set(ENV_SECRETS_PRIVATE_KEY_NAME, fc.exportPrivateKeyPemForCloning());
		registerEnvSecretDecryptor(decryptEnvValue);
	} else if (fc) {
		logger.warn?.(
			'env-secrets keypair not found on this worker; encrypted .env values will not be decrypted until it is present'
		);
	} else {
		// KMS custody: process.env injection is unavailable; components read via scope.secrets.
		logger.debug?.('env-secrets: non-file key custody active; process.env injection disabled (use scope.secrets)');
	}
}
