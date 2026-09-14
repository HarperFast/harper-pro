import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { get } from '../core/utility/environment/environmentManager.js';
import { CONFIG_PARAMS } from '../core/utility/hdbTerms.ts';
import harperLogger from '../core/utility/logging/harper_logger.js';

const logger = harperLogger.forComponent('replication').conditional;

export const CLONE_ATTEMPT_FILE = '.cloneAttempt.json';
export const CLONE_COMPLETION_GRACE_MS = 60_000;

type CloneAttemptMarker = {
	attemptId?: unknown;
	leaderHost?: unknown;
	completedAt?: unknown;
};

export function cloneAttemptPath(rootPath: string): string {
	return join(rootPath, CLONE_ATTEMPT_FILE);
}

export function reusableCloneAttemptId(marker: CloneAttemptMarker | undefined, leaderHost: string | undefined) {
	return marker?.completedAt === undefined && marker?.leaderHost === leaderHost && typeof marker?.attemptId === 'string'
		? marker.attemptId
		: undefined;
}

export function completeCloneAttempt(rootPath: string, completedAt = Date.now()): void {
	const path = cloneAttemptPath(rootPath);
	try {
		const marker: CloneAttemptMarker = JSON.parse(readFileSync(path, 'utf8'));
		const temporaryPath = `${path}.${process.pid}.tmp`;
		writeFileSync(temporaryPath, JSON.stringify({ ...marker, completedAt }), { encoding: 'utf8', mode: 0o600 });
		renameSync(temporaryPath, path);
	} catch (error) {
		logger.warn?.('Could not mark the clone attempt complete', error);
	}
}

/**
 * The host this node is currently being cloned from, or undefined when no clone is in flight. Both halves
 * are required because each covers the other's failure mode: the environment variable proves this
 * *process* is a clone run (a plain `harper run` restart never sets it, so a marker left by a killed
 * clone authorizes nothing), and the marker proves the attempt has not been retired (clearing the variable
 * on the main thread leaves every already-running worker's inherited copy set). A completed marker remains
 * eligible only for the bounded reverse-connect grace. A marker that names no source reads as no attempt.
 */
export function cloneAttemptSource(rootPath: string = get(CONFIG_PARAMS.ROOTPATH)): string | undefined {
	try {
		if (!process.env.HARPER_CLONE_ATTEMPT || !rootPath) return undefined;
		const path = cloneAttemptPath(rootPath);
		if (!existsSync(path)) return undefined;
		const marker: CloneAttemptMarker = JSON.parse(readFileSync(path, 'utf8'));
		if (
			marker.completedAt !== undefined &&
			(typeof marker.completedAt !== 'number' ||
				!Number.isFinite(marker.completedAt) ||
				marker.completedAt + CLONE_COMPLETION_GRACE_MS <= Date.now())
		)
			return undefined;
		const source = marker.leaderHost;
		return typeof source === 'string' && source ? source : undefined;
	} catch (error) {
		// A marker that cannot be read disables the base-copy filter for the rest of the clone, and nothing
		// else reports that, so it is worth a line even though the answer is still "copy in full".
		logger.warn?.('Could not read the clone attempt marker', error);
		return undefined;
	}
}
