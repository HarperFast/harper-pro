/**
 * Coverage for the decode-independent node posture cache (harper-pro#460).
 *
 * mergeReconstructedNode can only preserve a constrained peer's directional `replicates` when it holds
 * a last-decoded record in memory. On a fresh process boot with no such record, a decode-failing row
 * would reconstruct to full-mesh `replicates: true` (widening). This cache persists each peer's
 * last-known-good posture across restarts so the constraint is recovered instead.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as env from '#src/core/utility/environment/environmentManager';
import { CONFIG_PARAMS } from '#src/core/utility/hdbTerms';
import {
	reconstructNodeFromKey,
	mergeReconstructedNode,
	recordNodePosture,
	getCachedNodePosture,
	clearNodePostureCache,
	selfNodeReplicates,
} from '#src/replication/knownNodes';

describe('node posture cache (harper-pro#460)', () => {
	let rootPath;
	let originalRootPath;
	const constrained = {
		name: 'edge-1',
		url: 'ws://127.0.0.1:9933',
		replicates: { sendsTo: [{ database: 'data' }], receivesFrom: [{ database: 'data' }] },
	};

	before(() => {
		originalRootPath = env.get(CONFIG_PARAMS.ROOTPATH);
		rootPath = mkdtempSync(join(tmpdir(), 'harper-posture-'));
		env.setProperty(CONFIG_PARAMS.ROOTPATH, rootPath);
		clearNodePostureCache();
	});

	after(() => {
		env.setProperty(CONFIG_PARAMS.ROOTPATH, originalRootPath);
		clearNodePostureCache();
		rmSync(rootPath, { recursive: true, force: true });
	});

	it('persists a decoded record and recovers its constraint after a restart (reload from disk)', () => {
		recordNodePosture(constrained);
		assert.ok(existsSync(join(rootPath, 'replication-node-posture.json')));
		clearNodePostureCache(); // simulate a fresh process reading the file back
		assert.deepEqual(getCachedNodePosture('edge-1').replicates, constrained.replicates);
	});

	it('reconstruct + cache merge keeps the constraint instead of widening to replicates:true', () => {
		clearNodePostureCache();
		const merged = mergeReconstructedNode(reconstructNodeFromKey('edge-1'), getCachedNodePosture('edge-1'));
		assert.deepEqual(merged.replicates, constrained.replicates);
		assert.notEqual(merged.replicates, true);
	});

	it('does not cache a reconstruct descriptor (no url) as a real record', () => {
		clearNodePostureCache();
		recordNodePosture({ name: 'edge-2', replicates: true });
		assert.equal(getCachedNodePosture('edge-2'), undefined);
	});

	it('selfNodeReplicates defaults to replicating when the cached posture has no replicates field', () => {
		clearNodePostureCache();
		recordNodePosture({ name: 'edge-3', url: 'ws://127.0.0.1:9944' }); // decoded, but no replicates
		const rangeVisibleNullSelf = { getSync: () => null, getKeys: (options) => [options?.start] };
		assert.equal(selfNodeReplicates(rangeVisibleNullSelf, 'edge-3'), true);
	});
});
