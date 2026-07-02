/**
 * File-tier key custody (ported from #505, Dawson Toth): a cluster-shared RSA-4096 env-secrets
 * keypair persisted under `<rootPath>/keys/`. The leader generates it on first boot; a cloning
 * node fetches the active private key from the leader through the restricted `get_key` path (see
 * cloneEnvSecretsKeys in cloneNode.ts and the custody-name gate in keyService.ts). Because every
 * node holds the same key, an `enc:v1:` value encrypted once by a client is stored/replicated
 * verbatim and decrypts on any node.
 *
 * On-disk names are per-kid — `envSecrets.<kid8>.private.pem`, where `<kid8>` is the first 8 hex
 * chars of the key's SHA-256 SPKI fingerprint — so a future rotation walk (P5) can stage multiple
 * keys side by side. A single key exists today; if several are present, the newest file becomes
 * the active (encrypt-side) key and all of them serve decrypt via the kid map.
 *
 * The envelope cryptography lives in core (`core/utility/secretEnvelope.ts`, itself ported from
 * this repo's #505 `envSecretCrypto.ts`) so core and Pro share one wire format.
 */
import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { fingerprintOf } from '../core/utility/secretEnvelope.ts';
import { getPrivateKeys } from '../core/security/keys.js';
import { getHdbBasePath } from '../core/utility/environment/environmentManager.js';
import { LICENSE_KEY_DIR_NAME } from '../core/utility/hdbTerms.ts';
import logger from '../core/utility/logging/harper_logger.js';

/** kid → private key PEM, plus the kid encrypt-side consumers (getPublicKey) use. */
export interface CustodyKeys {
	keys: Map<string, string>;
	activeKid: string;
}

const FILE_PREFIX = 'envSecrets.';
const PRIVATE_SUFFIX = '.private.pem';
const PUBLIC_SUFFIX = '.public.pem';

/**
 * Key-store name of the ACTIVE private key — a stable alias across rotations so a cloning node
 * can `get_key` it without knowing the kid first (kid discovery would need an extra authorized
 * operation during clone). This is also #505's original on-disk filename, kept as the
 * clone-facing name.
 */
export const ACTIVE_CUSTODY_KEY_NAME = 'envSecrets.private.pem';

/**
 * True for key-store names holding cluster secret-custody private keys. `get_key` refuses to
 * serve these to anything but internal / node-identity (`bypass_auth`) requests (#166).
 */
export function isCustodyKeyName(name: string): boolean {
	return name.startsWith(FILE_PREFIX) && name.endsWith(PRIVATE_SUFFIX);
}

/** The per-kid on-disk filename for a custody private key. */
export function privateKeyFileNameFor(kid: string): string {
	return `${FILE_PREFIX}${kid.slice(0, 8)}${PRIVATE_SUFFIX}`;
}

/** The public (SPKI PEM) half of a private key PEM. */
export function publicPemOf(privateKeyPem: string): string {
	return createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }) as string;
}

/** The kid (SHA-256 SPKI fingerprint) of a private key PEM. */
export function kidOfPrivateKeyPem(privateKeyPem: string): string {
	return fingerprintOf(publicPemOf(privateKeyPem));
}

function keysDir(): string {
	return join(getHdbBasePath(), LICENSE_KEY_DIR_NAME);
}

function privateKeyFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((file) => isCustodyKeyName(file));
}

/** True when any custody private key exists on disk (without reading it). */
export function hasFileKeys(): boolean {
	return privateKeyFiles(keysDir()).length > 0;
}

/**
 * Load all on-disk custody keys into a kid map. Returns undefined when none exist. The kid comes
 * from the key material itself (never trusted from the filename); with several keys the newest
 * file is the active one.
 */
export function loadFileKeys(): CustodyKeys | undefined {
	const dir = keysDir();
	const files = privateKeyFiles(dir);
	if (files.length === 0) return undefined;
	const keys = new Map<string, string>();
	let activeKid: string | undefined;
	let activeMtime = -Infinity;
	for (const file of files) {
		const filePath = join(dir, file);
		try {
			const privateKeyPem = readFileSync(filePath, 'utf8');
			const kid = kidOfPrivateKeyPem(privateKeyPem);
			keys.set(kid, privateKeyPem);
			const { mtimeMs } = statSync(filePath);
			if (mtimeMs > activeMtime) {
				activeMtime = mtimeMs;
				activeKid = kid;
			}
		} catch (error) {
			logger.error?.(`Skipping unreadable env-secrets key file ${filePath}: ${(error as Error).message}`);
		}
	}
	if (!activeKid) return undefined;
	if (keys.size > 1) {
		logger.warn?.(`${keys.size} env-secrets keys on disk; using ${activeKid.slice(0, 8)} as the active key`);
	}
	return { keys, activeKid };
}

/**
 * Ensure the shared keypair exists (generating + persisting on first boot), then return it.
 * Generation only happens when NO custody key files exist at all: files that exist but cannot be
 * read (permissions, disk fault) abort instead — silently generating a replacement would split
 * the cluster key and permanently orphan every existing `enc:v1:` value.
 */
export function ensureFileKeys(): CustodyKeys {
	const existing = loadFileKeys();
	if (existing) return existing;
	if (hasFileKeys()) {
		throw new Error(
			'env-secrets key files exist under keys/ but none could be read; refusing to generate a replacement keypair — fix permissions or remove the unreadable files'
		);
	}
	logger.notify?.('Generating cluster env-secrets keypair');
	const { privateKey, publicKey } = generateKeyPairSync('rsa', {
		modulusLength: 4096,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});
	const kid = fingerprintOf(publicKey as string);
	const dir = keysDir();
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, privateKeyFileNameFor(kid)), privateKey, { mode: 0o600 });
	writeFileSync(join(dir, `${FILE_PREFIX}${kid.slice(0, 8)}${PUBLIC_SUFFIX}`), publicKey, { mode: 0o644 });
	return { keys: new Map([[kid, privateKey as string]]), activeKid: kid };
}

/**
 * Expose the custody private keys to core's key store so the restricted `get_key` path can serve
 * them to a cloning node: each key under its per-kid filename, plus the active key under the
 * stable ACTIVE_CUSTODY_KEY_NAME alias. File tier only — the injected tier never enters the
 * key store.
 */
export function registerCustodyKeysInKeyStore(custodyKeys: CustodyKeys): void {
	const privateKeys = getPrivateKeys();
	for (const [kid, privateKeyPem] of custodyKeys.keys) {
		privateKeys.set(privateKeyFileNameFor(kid), privateKeyPem);
	}
	privateKeys.set(ACTIVE_CUSTODY_KEY_NAME, custodyKeys.keys.get(custodyKeys.activeKid)!);
}
