/**
 * Injected-tier key ingestion: the host/orchestrator (Fabric) provisions the cluster secrets
 * private key into the process instead of the disk. Two channels, fd-first (see
 * `consumeInjectedKeyMaterial` in custodyState.ts for the channel details and the fd-close
 * security contract).
 *
 * The actual read/scrub/close lives in the dependency-free `custodyState.ts` so it can run at the
 * very top of boot (`bin/harper.js`), closing the fd BEFORE any worker thread or subprocess is
 * spawned — an open, non-close-on-exec fd is inherited by every descendant that shares the fd
 * table, so the key must be off it before anything forks (harper-pro#530). This module is the
 * logging-capable front door: it consumes the cached material and surfaces any deferred read error.
 */
import logger from '../core/utility/logging/harper_logger.js';
import {
	consumeInjectedKeyMaterial,
	takeInjectedIngestionError,
	SECRETS_KEY_FD_ENV,
	SECRETS_KEY_B64_ENV,
} from './custodyState.ts';

export { SECRETS_KEY_FD_ENV, SECRETS_KEY_B64_ENV };

/**
 * Consume the injected key channels (idempotent — reads the fd once, closes it, scrubs both env
 * vars) and return the private key PEM, or undefined when no material is present. Logs a deferred
 * read/misconfig error if the top-of-boot consume recorded one.
 */
export function ingestInjectedMaterial(): string | undefined {
	const pem = consumeInjectedKeyMaterial();
	const error = takeInjectedIngestionError();
	if (error) logger.error?.(error);
	return pem;
}
