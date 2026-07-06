/**
 * Dependency-free custody boot state. Two concerns live here precisely because this module pulls
 * in nothing but `node:fs` — cloneNode and `bin/harper.js` can import it at the very top of boot,
 * before the key-store/database/logging import graph exists:
 *
 *  1. Clone-bootstrap flag — cloneNode sets it before starting Harper for a clone so the file
 *     custody tier (keyCustody.ts) never self-generates a cluster env-secrets keypair while the
 *     leader's key is still being cloned. A clone-local key would diverge the cluster and could
 *     even encrypt new secrets before the real key arrives. The flag is cleared only after the
 *     leader's key has been cloned and registered; a clone that cannot fetch a key stays dormant
 *     for the rest of the bootstrap session (fail-closed).
 *
 *  2. Injected key-material ingestion (harper-pro#530) — reads and scrubs the injected channels
 *     exactly once and, crucially, closes the fd immediately after the read so no forked or
 *     threaded descendant can inherit it. See `consumeInjectedKeyMaterial`.
 */
import { readFileSync, closeSync } from 'node:fs';

let cloneBootstrapInProgress = false;

export function setCloneBootstrapInProgress(inProgress: boolean): void {
	cloneBootstrapInProgress = inProgress;
}

export function isCloneBootstrapInProgress(): boolean {
	return cloneBootstrapInProgress;
}

export const SECRETS_KEY_FD_ENV = 'HARPER_SECRETS_KEY_FD';
export const SECRETS_KEY_B64_ENV = 'HARPER_SECRETS_PRIVATE_KEY_B64';

let ingested = false;
let cachedPem: string | undefined;
let ingestionError: string | undefined;

/**
 * Consume the injected key channels exactly once and cache the result. Fd-first:
 *
 *  - `HARPER_SECRETS_KEY_FD` — an fd (a read-once pipe or an unlinked tmpfs file) the entrypoint
 *    opened for us with `exec 3<`, i.e. WITHOUT close-on-exec. We read it to EOF and then close it
 *    right away: bash cannot set `FD_CLOEXEC` on it, so until we close it that same open, readable
 *    fd is inherited by every descendant the process forks or every thread that shares the fd
 *    table — a compromised component could read the cluster private key straight off
 *    `/proc/self/fd/3` (host-manager#130, harper-pro#530). Closing it here is the consumer half of
 *    that delivery contract.
 *  - `HARPER_SECRETS_PRIVATE_KEY_B64` — base64 PEM in the environment. Fallback only: the value
 *    existed in `environ` at spawn time (visible to `/proc/<pid>/environ` and `ps e` before we
 *    delete it), which is why the fd channel is preferred.
 *
 * Both env vars are deleted unconditionally on the first call, whichever channel wins, so a later
 * spawn can never inherit them. Idempotent by design: the fd is read-once, so `bin/harper.js` can
 * call this at the top of boot (closing the fd before any worker thread or subprocess is spawned)
 * and the custody component can call it again later to retrieve the same cached PEM. Kept
 * logging-free so it stays dependency-free; a misconfiguration/read error is stashed in
 * `ingestionError` for `ingestInjectedMaterial` to log once the logger is available.
 */
export function consumeInjectedKeyMaterial(): string | undefined {
	if (ingested) return cachedPem;
	ingested = true;
	const fdValue = process.env[SECRETS_KEY_FD_ENV];
	const b64Value = process.env[SECRETS_KEY_B64_ENV];
	delete process.env[SECRETS_KEY_FD_ENV];
	delete process.env[SECRETS_KEY_B64_ENV];
	if (fdValue !== undefined) {
		// small non-negative integer only — anything else is a misconfiguration, not an fd
		if (/^\d{1,9}$/.test(fdValue)) {
			const fd = Number(fdValue);
			try {
				cachedPem = readFileSync(fd, 'utf8');
				return cachedPem;
			} catch (error) {
				ingestionError = `Failed reading secrets key from fd ${fd}: ${(error as Error).message}`;
			} finally {
				try {
					closeSync(fd);
				} catch {
					// fd already closed or was never valid
				}
			}
		} else {
			ingestionError = `${SECRETS_KEY_FD_ENV} must be a small non-negative integer; ignoring`;
		}
	}
	if (b64Value) {
		cachedPem = Buffer.from(b64Value, 'base64').toString('utf8');
	}
	return cachedPem;
}

/** Return (and clear) any error recorded by the last `consumeInjectedKeyMaterial`, so the custody
 *  component can log it once — the read itself runs logging-free at the top of boot. */
export function takeInjectedIngestionError(): string | undefined {
	const error = ingestionError;
	ingestionError = undefined;
	return error;
}

/** Reset ingestion state (cached PEM + one-shot latch + error). Intended for tests. */
export function resetInjectedIngestionForTests(): void {
	ingested = false;
	cachedPem = undefined;
	ingestionError = undefined;
}
