import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { get } from '../core/utility/environment/environmentManager.js';
import { CONFIG_PARAMS } from '../core/utility/hdbTerms.ts';
import harperLogger from '../core/utility/logging/harper_logger.js';

const logger = harperLogger.forComponent('replication').conditional;

export const CLONE_ATTEMPT_FILE = '.cloneAttempt.json';

export function cloneAttemptPath(rootPath: string): string {
	return join(rootPath, CLONE_ATTEMPT_FILE);
}

/**
 * The host this node is currently being cloned from, or undefined when no clone is in flight. Both halves
 * are required because each covers the other's failure mode: the environment variable proves this
 * *process* is a clone run (a plain `harper run` restart never sets it, so a marker left by a killed
 * clone authorizes nothing), and the marker proves the clone has not finished (clearing the variable on
 * the main thread leaves every already-running worker's inherited copy set). A marker that names no
 * source reads as no clone in flight.
 */
export function cloneAttemptSource(rootPath: string = get(CONFIG_PARAMS.ROOTPATH)): string | undefined {
	try {
		if (!process.env.HARPER_CLONE_ATTEMPT || !rootPath) return undefined;
		const path = cloneAttemptPath(rootPath);
		if (!existsSync(path)) return undefined;
		const source = JSON.parse(readFileSync(path, 'utf8'))?.leaderHost;
		return typeof source === 'string' && source ? source : undefined;
	} catch (error) {
		// A marker that cannot be read disables the base-copy filter for the rest of the clone, and nothing
		// else reports that, so it is worth a line even though the answer is still "copy in full".
		logger.warn?.('Could not read the clone attempt marker', error);
		return undefined;
	}
}
