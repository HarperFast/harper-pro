/**
 * Injected-tier key ingestion: the host/orchestrator (Fabric) provisions the cluster secrets
 * private key into the process instead of the disk. Two channels, fd-first:
 *
 *  1. `HARPER_SECRETS_KEY_FD` — a file descriptor (typically a read-once pipe) handed to us by
 *     the entrypoint; read to EOF, then closed. Preferred: the key bytes never appear in the
 *     process environment.
 *  2. `HARPER_SECRETS_PRIVATE_KEY_B64` — base64 of the PEM in the environment. Fallback only:
 *     even though the variable is deleted immediately on ingestion, the value existed in the
 *     environ at spawn time (visible to `/proc/<pid>/environ` captures and `ps e` before then) —
 *     that residue is why the fd channel is preferred.
 *
 * Both variables are scrubbed BEFORE any worker or job thread spawns: ingestion runs during
 * main-thread component load, which `startHTTPThreads` awaits before spawning workers, and job
 * workers copy `process.env` explicitly at spawn. Children therefore never inherit the material.
 */
import { readFileSync, closeSync } from 'node:fs';
import logger from '../core/utility/logging/harper_logger.js';

export const SECRETS_KEY_FD_ENV = 'HARPER_SECRETS_KEY_FD';
export const SECRETS_KEY_B64_ENV = 'HARPER_SECRETS_PRIVATE_KEY_B64';

/**
 * Consume and scrub the injected key channels. Returns the private key PEM, or undefined when no
 * material is present (or it was unreadable — logged). Always deletes both environment variables,
 * whichever channel is used, so a later spawn can never inherit them.
 */
export function ingestInjectedMaterial(): string | undefined {
	const fdValue = process.env[SECRETS_KEY_FD_ENV];
	const b64Value = process.env[SECRETS_KEY_B64_ENV];
	delete process.env[SECRETS_KEY_FD_ENV];
	delete process.env[SECRETS_KEY_B64_ENV];
	if (fdValue !== undefined) {
		// small non-negative integer only — anything else is a misconfiguration, not an fd
		if (/^\d{1,9}$/.test(fdValue)) {
			const fd = Number(fdValue);
			try {
				return readFileSync(fd, 'utf8');
			} catch (error) {
				logger.error?.(`Failed reading secrets key from fd ${fd}: ${(error as Error).message}`);
			} finally {
				try {
					closeSync(fd);
				} catch {
					// fd already closed or was never valid
				}
			}
		} else {
			logger.error?.(`${SECRETS_KEY_FD_ENV} must be a small non-negative integer; ignoring`);
		}
	}
	if (b64Value) {
		return Buffer.from(b64Value, 'base64').toString('utf8');
	}
	return undefined;
}
