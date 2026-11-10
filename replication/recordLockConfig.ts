import { isMainThread } from 'node:worker_threads';
import { getConfigObj } from '../core/config/configUtils.ts';
import * as env from '../core/utility/environment/environmentManager.js';
import { CONFIG_PARAMS } from '../core/utility/hdbTerms.ts';
import * as logger from '../core/utility/logging/harper_logger.js';

/**
 * `auto`: on, and the first home-map generation is established automatically (unset, the default).
 * `operator`: on, every generation is published by an operator (`true`, the 5.3 meaning).
 * `off`: cluster-scoped `lock()` fails closed (`false`, LMDB, or a value this node cannot read as a boolean).
 */
export type RecordLockMode = 'auto' | 'operator' | 'off';

export interface RecordLockSetting {
	mode: RecordLockMode;
	offBecause?: 'config' | 'engine';
}

interface SettingLog {
	info?: (message: string) => void;
	warn?: (message: string) => void;
	error?: (message: string) => void;
}

/**
 * Successor freshness is proven in the transaction-log-key domain the RocksDB receiver adopts
 * (harper-pro#790); the deprecated LMDB engine keys replicated writes by its own local clock, so no
 * barrier would ever match there, and LMDB stays off whatever the setting says.
 *
 * A configuration that cannot be read at all resolves to off, not to the default: only a successfully
 * read, absent key means "unset". A module-loading unit-test process has no boot properties file, so
 * `getConfigObj()` throws there.
 */
export function resolveRecordLockSetting(
	readConfigured: () => unknown,
	engine: string | undefined,
	log: SettingLog = {}
): RecordLockSetting {
	let configured: unknown;
	try {
		configured = readConfigured();
	} catch {
		return { mode: 'off', offBecause: 'config' };
	}
	const lmdb = engine === 'lmdb';
	if (configured === undefined || configured === null) {
		if (!lmdb) return { mode: 'auto' };
		log.info?.(
			'Cluster record locks are off on this node: they need the RocksDB storage engine, and this node uses LMDB'
		);
		return { mode: 'off', offBecause: 'engine' };
	}
	if (configured === true) {
		if (!lmdb) return { mode: 'operator' };
		log.error?.(
			'replication.recordLocks requires the RocksDB storage engine; cluster record locks stay disabled on this LMDB node'
		);
		return { mode: 'off', offBecause: 'engine' };
	}
	// A truthy non-boolean (a YAML `1`, a quoted "true") or a quoted "false" is not read either way.
	if (configured !== false)
		log.warn?.(
			`replication.recordLocks is set to ${JSON.stringify(configured)}, which is not a boolean; cluster record locks stay disabled`
		);
	return { mode: 'off', offBecause: 'config' };
}

/**
 * Read once, from the raw config tree rather than `env.get`, at module load: other modules read the
 * result at their own import time, and a value that changed between threads would make one worker
 * advertise a capability the process does not honor.
 */
const setting = resolveRecordLockSetting(
	() => getConfigObj()?.replication?.recordLocks,
	process.env.HARPER_STORAGE_ENGINE || env.get(CONFIG_PARAMS.STORAGE_ENGINE),
	isMainThread ? logger : {}
);
export const RECORD_LOCK_MODE: RecordLockMode = setting.mode;
export const CLUSTER_RECORD_LOCKS_ENABLED: boolean = setting.mode !== 'off';
export const RECORD_LOCK_HOMES_AUTOMATIC: boolean = setting.mode === 'auto';
