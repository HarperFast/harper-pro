/**
 * Whether this start may have lost page-cache data since the previous process, which decides whether
 * own-origin recovery runs (replication/DESIGN.md, non-obvious behavior 39). rocksdb-js appends transaction-log
 * commits without an fsync, so a process exit with the OS up keeps the log's tail; only an OS restart or a
 * failed fsync can drop it.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { RocksDatabase } from '@harperfast/rocksdb-js';
import * as logger from '../core/utility/logging/harper_logger.js';

const BOOT_ID_PATTERN = /^[\w.:-]{1,128}$/;
const SYNC_FAILURE_MARKER = 'own-origin-recovery-log-sync-failed';
// both paths that latch rocksdb-js's per-store logSyncFailed report it with this phrase
const SYNC_FAILURE_PATTERN = /could not be synced/;

export function validBootId(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return BOOT_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** The kernel's identity for this boot; undefined where none is authoritative (Windows), so every start recovers. */
export function readBootId(platform: NodeJS.Platform = process.platform): string | undefined {
	const override = process.env.HARPER_TEST_BOOT_ID;
	if (override !== undefined) {
		logger.error?.('HARPER_TEST_BOOT_ID is set, so this node cannot tell an OS restart from a process restart');
		return validBootId(override);
	}
	try {
		if (platform === 'linux') return validBootId(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'));
		if (platform === 'darwin')
			return validBootId(
				execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
					encoding: 'utf8',
					timeout: 2000,
					maxBuffer: 1024,
					stdio: ['ignore', 'pipe', 'ignore'],
				})
			);
	} catch (error) {
		logger.warn?.('Could not read the OS boot identity; own-origin recovery runs on this start', error);
	}
	return undefined;
}

export interface SyncFailureMarker {
	present: boolean;
	/** The token to clear it by; undefined when it could not be read, so it is never cleared. */
	token?: string;
}

/** Only a missing file means no failure was recorded; any other read error counts as one. */
export function readSyncFailureMarker(rootPath: string): SyncFailureMarker {
	try {
		return { present: true, token: readFileSync(join(rootPath, SYNC_FAILURE_MARKER), 'utf8') };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { present: false };
		logger.warn?.('Could not read the transaction-log sync failure marker; treating it as present', error);
		return { present: true };
	}
}

/**
 * Remove the marker only if no failure was recorded since it was read. Synchronous, like the listener that
 * rewrites it, so the two cannot interleave on the thread that runs both.
 */
export function clearSyncFailureMarker(rootPath: string, token: string): void {
	const path = join(rootPath, SYNC_FAILURE_MARKER);
	try {
		if (readFileSync(path, 'utf8') === token) unlinkSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
			logger.warn?.('Could not clear the transaction-log sync failure marker; the next start recovers again', error);
	}
}

/**
 * Written in place, and kept even if its fsync fails: it only has to outlive a restart on this boot (a new boot
 * recovers anyway), which the page cache gives it, and a torn write still reads as present.
 */
export function recordSyncFailure(rootPath: string): void {
	try {
		const fd = openSync(join(rootPath, SYNC_FAILURE_MARKER), 'w');
		try {
			writeSync(fd, randomUUID());
			try {
				fsyncSync(fd);
			} catch {}
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		logger.error?.(
			'Could not record a transaction-log sync failure; a restart on this boot will not recover own-origin writes from peers',
			error
		);
	}
}

export function onRocksWarning(rootPath: string, message: unknown): void {
	try {
		logger.warn?.(message);
		if (typeof message === 'string' && SYNC_FAILURE_PATTERN.test(message)) recordSyncFailure(rootPath);
	} catch {}
}

let watching = false;
/** rocksdb-js reports each store's sync failure once, and only to a listener registered when it happens. */
export function watchLogSyncFailures(rootPath: string): void {
	if (watching || !rootPath) return;
	try {
		RocksDatabase.on('log.warn', (message: unknown) => onRocksWarning(rootPath, message));
		watching = true;
	} catch (error) {
		logger.error?.('Could not watch for transaction-log sync failures', error);
	}
}
