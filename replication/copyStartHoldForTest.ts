/**
 * Test-only: parks a receiver's COPY_START before its record-lock reclone check, the way the deploy tests
 * park an install command, so state a test creates during the hold is in place before that check runs.
 * No deadline: a check that ran on a timeout would let the test pass without the ordering it exists to prove.
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
