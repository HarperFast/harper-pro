/**
 * Env-secret encryption (Pro). Fills the dormant decrypt hook that Harper core exposes
 * (`core/resources/envSecretDecryptor.ts`) so `.env` values written as `enc:v1:` envelopes are
 * decrypted into `process.env` at runtime. The cryptography and the private key live only here, so
 * the feature is gated by this component's presence — without harper-pro, core stays dormant.
 *
 * Key model: a single cluster-shared RSA-4096 "env-secrets" keypair. The leader generates it once
 * (first boot) and persists it to the keys/ dir; the private key is registered in core's key store
 * so the existing `get_key` operation can serve it to a cloning node (see cloneEnvSecretsKeys in
 * cloneNode). Because every node holds the same key, an `enc:v1:` value encrypted once by a client
 * is stored/replicated verbatim and decrypts on any node.
 *
 * Envelope + client flow are documented in core/docs/env-secret-encryption.md. The wire format is
 * hybrid: AES-256-GCM encrypts the value, RSA-OAEP(SHA-256) wraps the AES key.
 */
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { decryptEnvelope, fingerprintOf } from './envSecretCrypto.ts';
import { server } from '../core/server/Server.ts';
import { registerEnvSecretDecryptor } from '../core/resources/envSecretDecryptor.js';
import { ENV_ENCRYPTED_PREFIX } from '../core/utility/envFile.js';
import { getPrivateKeys } from '../core/security/keys.js';
import { getHdbBasePath } from '../core/utility/environment/environmentManager.js';
import { LICENSE_KEY_DIR_NAME } from '../core/utility/hdbTerms.js';
import { ClientError } from '../core/utility/errors/hdbError.js';
import logger from '../core/utility/logging/harper_logger.js';

// Filename of the shared private key in the keys/ dir. Also the name under which it is registered
// in core's key store, so `get_key { name: ENV_SECRETS_PRIVATE_KEY_NAME }` serves it to a cloning node.
export const ENV_SECRETS_PRIVATE_KEY_NAME = 'envSecrets.private.pem';
const ENV_SECRETS_PUBLIC_KEY_NAME = 'envSecrets.public.pem';
const SCHEME = 'enc:v1';
const ALGORITHM = 'RSA-OAEP-SHA256 + AES-256-GCM';

// Per-process cache, populated by ensureKeypair (main) / loadKeypair (workers).
let privateKeyPem: string | undefined;
let publicKeyPem: string | undefined;
let keyFingerprint: string | undefined;

function keysDir(): string {
	return join(getHdbBasePath(), LICENSE_KEY_DIR_NAME);
}

function cache(privatePem: string, publicPem: string): void {
	privateKeyPem = privatePem;
	publicKeyPem = publicPem;
	keyFingerprint = fingerprintOf(publicPem);
	// Expose the private key to the key store so `get_key` can clone it to new nodes.
	getPrivateKeys().set(ENV_SECRETS_PRIVATE_KEY_NAME, privatePem);
}

/** Load the keypair from disk into the cache. Returns false if it isn't present yet. */
function loadKeypair(): boolean {
	if (privateKeyPem) return true;
	const privatePath = join(keysDir(), ENV_SECRETS_PRIVATE_KEY_NAME);
	if (!existsSync(privatePath)) return false;
	const privatePem = readFileSync(privatePath, 'utf8');
	// Derive the public key rather than trusting a separate file.
	const publicPem = createPublicKey(privatePem).export({ type: 'spki', format: 'pem' }) as string;
	cache(privatePem, publicPem);
	return true;
}

/** Ensure the shared keypair exists (generating + persisting on first boot), then cache it. */
function ensureKeypair(): void {
	if (loadKeypair()) return;
	logger.notify?.('Generating cluster env-secrets keypair');
	const { privateKey, publicKey } = generateKeyPairSync('rsa', {
		modulusLength: 4096,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});
	const dir = keysDir();
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, ENV_SECRETS_PRIVATE_KEY_NAME), privateKey, { mode: 0o600 });
	writeFileSync(join(dir, ENV_SECRETS_PUBLIC_KEY_NAME), publicKey, { mode: 0o644 });
	cache(privateKey as string, publicKey as string);
}

/**
 * Decrypt an `enc:v1:` value via the pure envelope crypto. Synchronous (Node RSA/AES are sync) so it
 * plugs directly into core's loadEnv path. Throws on a wrong/missing key or a tampered envelope.
 */
function decryptEnvValue(value: string): string {
	if (!privateKeyPem && !loadKeypair()) {
		throw new Error('env-secrets keypair is not available on this node');
	}
	return decryptEnvelope(value.slice(ENV_ENCRYPTED_PREFIX.length), privateKeyPem!, keyFingerprint!);
}

interface PublicKeyRequest {
	operation?: string;
}

/** `get_secrets_public_key` — returns only PUBLIC material clients use to encrypt secret values. */
async function getSecretsPublicKey(_req: PublicKeyRequest) {
	if (!publicKeyPem && !loadKeypair()) {
		throw new ClientError('env-secrets keypair is not initialized');
	}
	return {
		publicKey: publicKeyPem,
		fingerprint: keyFingerprint,
		scheme: SCHEME,
		algorithm: ALGORITHM,
	};
}

/**
 * Main-thread entry point: ensure the shared keypair exists and expose the public key. Runs once;
 * the operations API only runs on the main thread (v5.1+), so the operation registers here.
 */
export function startOnMainThread(): void {
	ensureKeypair();
	registerEnvSecretDecryptor(decryptEnvValue);
	server.registerOperation?.({
		name: 'get_secrets_public_key',
		execute: getSecretsPublicKey,
		httpMethod: 'GET',
	});
}

/**
 * Worker-thread entry point: load the shared key (written by the leader / cloned at bootstrap) and
 * register the decryptor so `.env` files loaded in this worker decrypt `enc:v1:` values.
 */
export function start(): void {
	if (loadKeypair()) {
		registerEnvSecretDecryptor(decryptEnvValue);
	} else {
		logger.warn?.(
			'env-secrets keypair not found on this worker; encrypted .env values will not be decrypted until it is present'
		);
	}
}
