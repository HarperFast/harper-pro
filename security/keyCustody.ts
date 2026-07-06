/**
 * Secret-custody component (#166): selects a key-custody provider at startup and registers it
 * with core via `registerSecretCustody`, which installs the loadEnv decryptor and backs the
 * secret operations (core owns the `get_secrets_public_key` operation — this module registers no
 * operations of its own).
 *
 * Tiers:
 *  - `file` — cluster-shared keypair persisted under `keys/` (leader generates on first boot;
 *    cloning nodes fetch it through the restricted `get_key` path). Every thread, including job
 *    workers, loads it from disk. Trade-off: key material rests on disk and is served (to
 *    node-identity requests only) for cloning.
 *  - `injected` — key material handed to the main thread by the host (fd-first; see
 *    injectedKeyCustody.ts). Memory-only: never persisted, never in the `get_key` store — the
 *    platform provisions every node, so no clone path is needed. Workers receive the key via
 *    core's workerData provider hook, request (http) workers only — job workers never see it.
 *
 * Selection is automatic only when exactly one source exists: injected material present and no
 * on-disk key → injected; no injected material → file. When BOTH are present, custody refuses to
 * activate (on the main thread and, via a workerData marker, in every worker) and logs an error
 * demanding an explicit `secretCustody: provider: file|injected` config block.
 *
 * Ordering note: registration order vs `.env` loading is not load-bearing — core queues encrypted
 * entries it cannot decrypt yet and `registerSecretCustody` replays them (harper#1559), so even a
 * custody provider that comes up late heals the skipped values.
 */
import { workerData } from 'node:worker_threads';
import { registerSecretCustody, type SecretCustody } from '../core/resources/secretDecryptor.ts';
import { registerWorkerDataProvider } from '../core/server/threads/manageThreads.js';
import { THREAD_TYPES } from '../core/utility/hdbTerms.ts';
import { ENV_ENCRYPTED_PREFIX } from '../core/utility/envFile.ts';
import { parseEnvelopeFields, decryptEnvelope } from '../core/utility/secretEnvelope.ts';
import logger from '../core/utility/logging/harper_logger.js';
import {
	ensureFileKeys,
	loadFileKeys,
	hasFileKeys,
	registerCustodyKeysInKeyStore,
	publicPemOf,
	kidOfPrivateKeyPem,
	type CustodyKeys,
} from './fileKeyCustody.ts';
import { ingestInjectedMaterial, SECRETS_KEY_FD_ENV, SECRETS_KEY_B64_ENV } from './injectedKeyCustody.ts';
import {
	isCloneBootstrapInProgress,
	setCloneBootstrapInProgress,
	resetInjectedIngestionForTests,
} from './custodyState.ts';

export type { CustodyKeys };

/** The workerData property name the injected tier delivers key material under. */
export const CUSTODY_WORKER_DATA_KEY = 'secretCustody';

// Single-thread mode (threadCount === 0) runs both startOnMainThread and start in one process;
// `activated` keeps the second call from re-selecting, and `disabled` latches a refusal
// (ambiguous/invalid selection) so the in-process start() cannot fall through to the on-disk key
// that the selection just refused.
let activated = false;
let disabled = false;
let unregisterWorkerDataProvider: (() => void) | undefined;

function setWorkerDataProvider(provider: (options: { name?: string }) => unknown): void {
	unregisterWorkerDataProvider?.();
	unregisterWorkerDataProvider = registerWorkerDataProvider(CUSTODY_WORKER_DATA_KEY, provider);
}

/** Reset module state (selection + workerData provider). Intended for tests. */
export function resetKeyCustodyForTests(): void {
	activated = false;
	disabled = false;
	setCloneBootstrapInProgress(false);
	resetInjectedIngestionForTests();
	unregisterWorkerDataProvider?.();
	unregisterWorkerDataProvider = undefined;
}

/** A single-entry kid map from a private key PEM (the injected tier's shape today). */
export function custodyKeysFromPem(privateKeyPem: string): CustodyKeys {
	const kid = kidOfPrivateKeyPem(privateKeyPem);
	return { keys: new Map([[kid, privateKeyPem]]), activeKid: kid };
}

/**
 * Build core's SecretCustody from a kid map: decrypt resolves the key by the envelope's own kid;
 * the active-key fallback applies ONLY to kid-less envelopes — an unknown kid fails fast with a
 * clear error rather than attempting RSA with the wrong key (which would surface as an opaque
 * OpenSSL padding error). getPublicKey exposes the single ACTIVE key.
 */
export function buildCustody({ keys, activeKid }: CustodyKeys): SecretCustody {
	const publicKey = publicPemOf(keys.get(activeKid)!);
	return {
		decrypt(value: string): string {
			// core's SecretDecryptor contract passes the full `enc:v1:` value; the marker is stripped here
			const body = value.startsWith(ENV_ENCRYPTED_PREFIX) ? value.slice(ENV_ENCRYPTED_PREFIX.length) : value;
			const envelopeKid = parseEnvelopeFields(body).kid;
			if (envelopeKid && !keys.has(envelopeKid)) {
				throw new Error(`no secrets key for kid ${envelopeKid}`);
			}
			const kid = envelopeKid || activeKid;
			return decryptEnvelope(body, keys.get(kid)!, kid);
		},
		getPublicKey() {
			return { publicKey, fingerprint: activeKid };
		},
	};
}

/** The workerData provider for the injected tier: key material to request (http) workers only. */
export function makeWorkerDataProvider(custodyKeys: CustodyKeys) {
	return (options: { name?: string }) =>
		options.name === THREAD_TYPES.HTTP
			? { mode: 'injected', keys: Object.fromEntries(custodyKeys.keys), activeKid: custodyKeys.activeKid }
			: undefined;
}

export type ProviderChoice = 'file' | 'injected' | 'ambiguous' | 'invalid';

/** Pure selection: explicit config wins; auto only when at most one source exists. */
export function chooseProvider(explicit: unknown, injectedPresent: boolean, fileKeysPresent: boolean): ProviderChoice {
	if (explicit !== undefined) {
		return explicit === 'file' || explicit === 'injected' ? explicit : 'invalid';
	}
	if (injectedPresent && fileKeysPresent) return 'ambiguous';
	return injectedPresent ? 'injected' : 'file';
}

function activate(custodyKeys: CustodyKeys): void {
	registerSecretCustody(buildCustody(custodyKeys));
	activated = true;
}

// Custody stays off — latched in-process (single-thread mode runs start() in the same process,
// which must not fall through to the on-disk key the selection refused) and signalled to worker
// threads via the marker for the same reason.
function disableCustody(reason: string): void {
	logger.error?.(reason);
	disabled = true;
	setWorkerDataProvider(() => ({ mode: 'disabled' }));
}

export function startOnMainThread(options?: { provider?: string }): void {
	// always consume + scrub the injected channels, even when the file tier wins the selection
	const injectedPem = ingestInjectedMaterial();
	const choice = chooseProvider(options?.provider, injectedPem !== undefined, hasFileKeys());
	switch (choice) {
		case 'invalid':
			disableCustody(
				`secretCustody provider must be 'file' or 'injected' (got '${options?.provider}'); secret custody is disabled`
			);
			return;
		case 'ambiguous':
			disableCustody(
				'Both injected secrets-key material and an on-disk envSecrets key are present; refusing to choose. ' +
					'Set `secretCustody: provider: file|injected` in the Harper config. Secret custody is disabled until then.'
			);
			return;
		case 'injected': {
			if (injectedPem === undefined) {
				disableCustody(
					`secretCustody provider is 'injected' but no key material arrived via ${SECRETS_KEY_FD_ENV} or ${SECRETS_KEY_B64_ENV}; secret custody is disabled`
				);
				return;
			}
			let custodyKeys: CustodyKeys;
			try {
				custodyKeys = custodyKeysFromPem(injectedPem);
			} catch (error) {
				// never log the material itself — only the parse failure
				disableCustody(
					`Injected secrets key material is not a usable private key (${(error as Error).message}); secret custody is disabled`
				);
				return;
			}
			setWorkerDataProvider(makeWorkerDataProvider(custodyKeys));
			activate(custodyKeys);
			return;
		}
		case 'file': {
			if (injectedPem !== undefined) {
				logger.warn?.('Ignoring injected secrets-key material because the secretCustody provider is set to file');
			}
			// Clone gate (#166): during the clone bootstrap the file tier must not GENERATE a
			// keypair — the leader's key is cloned right after replication is up (cloneNode calls
			// activateFileCustodyFromDisk then). Loading an existing on-disk key stays allowed
			// (re-clone over an existing install).
			if (isCloneBootstrapInProgress() && !hasFileKeys()) {
				logger.notify?.('Node clone in progress: env-secrets custody stays dormant until the leader key is cloned');
				return;
			}
			const custodyKeys = ensureFileKeys();
			registerCustodyKeysInKeyStore(custodyKeys);
			activate(custodyKeys);
			return;
		}
	}
}

/**
 * Load the file-tier key(s) from disk and register custody — called by cloneNode after the
 * leader's key has been cloned, when component startup ran custody-dormant under the clone gate.
 * No-op (returns false) if custody is already active in this process: an already-active tier is
 * never silently replaced; a newly cloned key file becomes part of the map on the next boot.
 */
export function activateFileCustodyFromDisk(): boolean {
	if (activated || disabled) return false;
	const fileKeys = loadFileKeys();
	if (!fileKeys) return false;
	registerCustodyKeysInKeyStore(fileKeys);
	activate(fileKeys);
	return true;
}

export function start(options?: { provider?: string }): void {
	// single-thread mode: startOnMainThread already ran in this process — honor both its
	// activation and its refusal latch (falling through to loadFileKeys here would activate the
	// very key an ambiguous selection just refused)
	if (activated || disabled) return;
	const explicit = options?.provider;
	if (explicit !== undefined && explicit !== 'file' && explicit !== 'injected') {
		logger.error?.(
			`secretCustody provider must be 'file' or 'injected' (got '${explicit}'); secret custody is disabled`
		);
		return;
	}
	// workerData can be null (main thread) or any structured-cloneable value, including a
	// primitive — guard the `in` check, which throws on non-objects
	const ambient =
		typeof workerData === 'object' && workerData !== null ? (workerData as Record<string, unknown>) : undefined;
	const delivered = ambient?.[CUSTODY_WORKER_DATA_KEY] as
		| { mode: string; keys?: Record<string, string>; activeKid?: string }
		| undefined;
	if (ambient && CUSTODY_WORKER_DATA_KEY in ambient) {
		// Hardening: remove the material from the ambient workerData object as early as this
		// component runs, so later component/user code cannot read it. Residual: trusted built-ins
		// loading before this one could — accepted in-process posture (the decryptor itself is
		// ambient); the deferred-decrypt replay in core means nothing needs to read it earlier.
		delete ambient[CUSTODY_WORKER_DATA_KEY];
	}
	if (delivered?.mode === 'disabled') {
		logger.error?.(
			'Secret custody was disabled by the main thread (ambiguous or invalid provider configuration); set `secretCustody: provider: file|injected`'
		);
		return;
	}
	if (delivered?.mode === 'injected' && explicit !== 'file') {
		activate({ keys: new Map(Object.entries(delivered.keys!)), activeKid: delivered.activeKid! });
		return;
	}
	// Spawn paths that copy the environment before the main thread ingested (e.g. dynamic threads)
	// can leave the injected channels visible here: ingest + scrub in this worker rather than
	// leaving raw key material readable in process.env.
	const injectedPem = ingestInjectedMaterial();
	if (injectedPem !== undefined && explicit !== 'file') {
		try {
			activate(custodyKeysFromPem(injectedPem));
		} catch (error) {
			// never log the material itself — only the parse failure; latch so this thread cannot
			// fall through to a mismatched tier
			disableCustody(
				`Injected secrets key material is not a usable private key (${(error as Error).message}); secret custody is disabled`
			);
		}
		return;
	}
	if (explicit === 'injected') {
		logger.error?.(
			'secretCustody provider is injected but no key material reached this worker; secret custody is disabled'
		);
		return;
	}
	const fileKeys = loadFileKeys();
	if (fileKeys) {
		// workers also serve `get_key` (replication operation requests dispatch on worker threads),
		// so the key store must be populated here too — same as #505's worker-side cache()
		registerCustodyKeysInKeyStore(fileKeys);
		activate(fileKeys);
		return;
	}
	if (hasFileKeys()) {
		// files exist but none could be read (loadFileKeys logged each) — surface loudly rather
		// than running silently dormant on what is likely a permission/disk fault
		logger.error?.('env-secrets key files exist under keys/ but none could be read on this thread');
		return;
	}
	logger.debug?.(
		'No secret-custody key material on this thread; encrypted values stay deferred until custody registers'
	);
}
