import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { get } from '../core/utility/environment/environmentManager.js';
import { CONFIG_PARAMS } from '../core/utility/hdbTerms.ts';
import harperLogger from '../core/utility/logging/harper_logger.js';

const logger = harperLogger.forComponent('replication').conditional;

export const CLONE_ATTEMPT_FILE = '.cloneAttempt.json';
export const CLONE_COMPLETION_GRACE_MS = 60_000;
export const CLONE_COMPLETED_AT_ENV = 'HARPER_CLONE_COMPLETED_AT';

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

export function completeCloneAttempt(rootPath: string, completedAt = Date.now()): string | undefined {
	const path = cloneAttemptPath(rootPath);
	let marker: CloneAttemptMarker;
	try {
		marker = JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		logger.warn?.('Could not read the clone attempt while marking it complete', error);
		return undefined;
	}
	if (typeof marker?.attemptId !== 'string') return undefined;
	try {
		const temporaryPath = `${path}.${process.pid}.tmp`;
		writeFileSync(temporaryPath, JSON.stringify({ ...marker, completedAt }), { encoding: 'utf8', mode: 0o600 });
		renameSync(temporaryPath, path);
	} catch (error) {
		logger.warn?.('Could not mark the clone attempt complete', error);
	}
	return marker.attemptId;
}

/**
 * The host this node is currently being cloned from, or undefined when no clone is in flight. Both halves
 * are required because each covers the other's failure mode: the environment variable proves this
 * *process* is a clone run (a plain `harper run` restart never sets it, so a marker left by a killed
 * clone authorizes nothing), and the marker proves the attempt has not been retired (clearing the variable
 * on the main thread leaves every already-running worker's inherited copy set). A completed marker remains
 * eligible only for the bounded reverse-connect grace; an inherited completion time provides the same bound
 * across an internal restart if stamping the marker failed. A marker that names no source reads as no attempt.
 *
 * The inherited completion time carries no attempt id, so it is sound only while `cloneNode()` runs at most
 * once per process (`bin/harper.js`): a second attempt could leave a worker forked under the first carrying
 * that attempt's stamp, which would then bound the new in-flight marker.
 */
export function cloneAttemptSource(rootPath: string = get(CONFIG_PARAMS.ROOTPATH)): string | undefined {
	try {
		if (!process.env.HARPER_CLONE_ATTEMPT || !rootPath) return undefined;
		const path = cloneAttemptPath(rootPath);
		if (!existsSync(path)) return undefined;
		const marker: CloneAttemptMarker = JSON.parse(readFileSync(path, 'utf8'));
		const completedAt = marker?.completedAt ?? process.env[CLONE_COMPLETED_AT_ENV];
		if (completedAt !== undefined) {
			const now = Date.now();
			const parsedCompletedAt = typeof completedAt === 'string' ? Number(completedAt) : completedAt;
			if (
				typeof parsedCompletedAt !== 'number' ||
				!Number.isFinite(parsedCompletedAt) ||
				parsedCompletedAt - now > CLONE_COMPLETION_GRACE_MS ||
				parsedCompletedAt + CLONE_COMPLETION_GRACE_MS <= now
			)
				return undefined;
		}
		const source = marker?.leaderHost;
		return typeof source === 'string' && source ? source : undefined;
	} catch (error) {
		// A marker that cannot be read disables the base-copy filter for the rest of the clone, and nothing
		// else reports that, so it is worth a line even though the answer is still "copy in full".
		logger.warn?.('Could not read the clone attempt marker', error);
		return undefined;
	}
}
