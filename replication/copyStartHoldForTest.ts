/**
 * Test-only holds on a receiver's copy pass:
 * - COPY_START is parked before its record-lock reclone check, the way the deploy tests park an install command, so
 *   state a test creates during the hold is in place before that check runs. No deadline: a check that ran on a
 *   timeout would let the test pass without the ordering it exists to prove.
 * - The pass's copy-bound settle reports not done, so it retries as after a failed write, leaving the pass open while
 *   the source's log tail applies.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import harperLogger from '../core/utility/logging/harper_logger.js';
import type { Logger } from '../core/utility/logging/logger.ts';
const { forComponent } = harperLogger;

const logger = forComponent('replication').conditional as Logger;

const HOLD_DIRECTORY = process.env.HARPER_TEST_HOLD_COPY_START_DIR;
export const copyStartHoldDatabaseForTest = HOLD_DIRECTORY ? process.env.HARPER_TEST_HOLD_COPY_START_DB : undefined;
const HOLD_PEER = process.env.HARPER_TEST_HOLD_COPY_START_PEER;

export function holdsCopyStartFromPeerForTest(peer: string): boolean {
	return !HOLD_PEER || HOLD_PEER === peer;
}

export async function holdCopyStartForTest(superseded: () => boolean): Promise<void> {
	const release = join(HOLD_DIRECTORY!, 'release');
	if (existsSync(release)) return;
	writeFileSync(join(HOLD_DIRECTORY!, 'held'), String(Date.now()));
	logger.warn?.(`[test] holding COPY_START for db "${copyStartHoldDatabaseForTest}" until ${release} exists`);
	while (!existsSync(release) && !superseded()) await delay(50);
}

const SETTLE_HOLD_DIRECTORY = process.env.HARPER_TEST_HOLD_COPY_SETTLE_DIR;
const SETTLE_HOLD_PEER = process.env.HARPER_TEST_HOLD_COPY_SETTLE_PEER;

/** True while `<dir>/release` is absent, for a pass of the named database from the named peer (any, when unset). */
export function copySettleHeldForTest(databaseName: string, peer: string): boolean {
	if (!SETTLE_HOLD_DIRECTORY || process.env.HARPER_TEST_HOLD_COPY_SETTLE_DB !== databaseName) return false;
	if ((SETTLE_HOLD_PEER && SETTLE_HOLD_PEER !== peer) || existsSync(join(SETTLE_HOLD_DIRECTORY, 'release')))
		return false;
	const held = join(SETTLE_HOLD_DIRECTORY, 'held');
	if (!existsSync(held)) {
		writeFileSync(held, String(Date.now()));
		logger.warn?.(
			`[test] holding the copy settle for db "${databaseName}" until ${SETTLE_HOLD_DIRECTORY}/release exists`
		);
	}
	return true;
}
