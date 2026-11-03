/**
 * Test-only: parks a receiver's COPY_START before its record-lock reclone check, the way the deploy tests
 * park an install command. While `<HARPER_TEST_HOLD_COPY_START_DIR>/release` is absent, every COPY_START
 * for `HARPER_TEST_HOLD_COPY_START_DB` writes `<dir>/held` and waits, so state a test creates during the
 * hold is in place before any copy of that database decides the reclone flag. No deadline: a check that
 * ran on a timeout would let the test pass without the ordering it exists to prove.
 * Covered by integrationTests/cluster/recordLockClonedNode.test.mjs.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import harperLogger from '../core/utility/logging/harper_logger.js';
import type { Logger } from '../core/utility/logging/logger.ts';
const { forComponent } = harperLogger;

const logger = forComponent('replication').conditional as Logger;

const HOLD_DIRECTORY = process.env.HARPER_TEST_HOLD_COPY_START_DIR;
/** Undefined unless the process was started with both variables; the COPY_START path compares this constant. */
export const copyStartHoldDatabaseForTest = HOLD_DIRECTORY ? process.env.HARPER_TEST_HOLD_COPY_START_DB : undefined;

export async function holdCopyStartForTest(superseded: () => boolean): Promise<void> {
	const release = join(HOLD_DIRECTORY!, 'release');
	if (existsSync(release)) return;
	writeFileSync(join(HOLD_DIRECTORY!, 'held'), String(Date.now()));
	logger.warn?.(`[test] holding COPY_START for db "${copyStartHoldDatabaseForTest}" until ${release} exists`);
	while (!existsSync(release) && !superseded()) await delay(50);
}
