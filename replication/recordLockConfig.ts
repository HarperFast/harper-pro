import { isMainThread } from 'node:worker_threads';
import { getConfigObj } from '../core/config/configUtils.ts';
import * as env from '../core/utility/environment/environmentManager.js';
import { CONFIG_PARAMS } from '../core/utility/hdbTerms.ts';
import * as logger from '../core/utility/logging/harper_logger.js';

/**
 * `replication.recordLocks: true` admits this node to cluster-wide record locks (harper-pro#438); off,
 * a cluster-scoped `lock()` fails closed rather than silently arbitrating on one node.
 *
 * Read from the raw config tree, NOT `env.get`: `env.get` resolves only keys registered in core's
 * `CONFIG_PARAM_MAP` (`knownNodes.ts` notes the same limit for other replication knobs), and this key
 * is harper-pro's own — registering it would be a core change. Read once: a value that changed
 * between threads would make one worker advertise a capability the process does not honor.
 *
 * `getConfigObj()` throws when no boot properties file exists yet (a module-loading unit-test
 * process, unlike a real server, never boots one). Every other `getConfigObj()` call site in the
 * codebase defers the call into a function body for exactly this reason; this one can't, because
 * the result is a module-scoped constant read by other modules at their own import time. Treat the
 * throw the same as "not configured": fail closed, matching this module's own default.
 */
let configured: unknown;
try {
	configured = getConfigObj()?.replication?.recordLocks;
} catch {
	configured = undefined;
}
// Only a real boolean `true` enables it; a truthy non-boolean (a YAML `1`, a quoted `"true"`) would
// leave the node advertising `recordLocks: 0` and registering the fail-closed transport, so warn
// rather than let an operator believe the switch is on.
if (configured && typeof configured !== 'boolean')
	logger.warn?.(
		`replication.recordLocks is set to ${JSON.stringify(configured)}, which is not the boolean true; cluster record locks stay disabled`
	);
// Successor freshness is proven in the transaction-log-key domain the RocksDB receiver adopts
// (harper-pro#790); the deprecated LMDB engine keys replicated writes by its own local clock, so no
// barrier would ever match there. Refuse the switch outright rather than advertise a level every
// handoff then times out on.
const engineIsLMDB = () => (process.env.HARPER_STORAGE_ENGINE || env.get(CONFIG_PARAMS.STORAGE_ENGINE)) === 'lmdb';
if (configured === true && engineIsLMDB())
	logger.error?.(
		'replication.recordLocks requires the RocksDB storage engine; cluster record locks stay disabled on this LMDB node'
	);
/**
 * Whether a `replication.recordLocks` value turns record locks on for this engine: only a real boolean `true`, and
 * not on LMDB. A clone applies it to the configuration it installed, which this module loaded before.
 */
export function recordLocksConfiguredFrom(value: unknown): boolean {
	return value === true && !engineIsLMDB();
}
export const RECORD_LOCKS_CONFIGURED: boolean = recordLocksConfiguredFrom(configured);
/**
 * False until `admitClusterRecordLocks` runs at a replication startup hook, after the catalog has
 * loaded: `storage.engine` only picks the engine of a database created from now on, so an `.mdb`
 * database kept by an in-place upgrade from v4 still opens on LMDB.
 */
export let CLUSTER_RECORD_LOCKS_ENABLED = false;
export let RECORD_LOCKS_REFUSAL: string | undefined;
let admitted = false;

export const RECORD_LOCKS_LMDB_REFUSAL =
	"cluster record locks are off on this node: replication.recordLocks is true, but some replicated databases on this node are opened on LMDB, which record locks do not support (the node log names them); migrate them to RocksDB (storage.migrateOnStart) and restart, or lock with { scope: 'node' } for a node-local lock";

export function recordLockAdmission(
	configuredOn: boolean,
	lmdbDatabases: readonly string[]
): { enabled: boolean; refusal?: string } {
	if (!configuredOn) return { enabled: false };
	return lmdbDatabases.length > 0 ? { enabled: false, refusal: RECORD_LOCKS_LMDB_REFUSAL } : { enabled: true };
}

/**
 * Decides `CLUSTER_RECORD_LOCKS_ENABLED` once per thread, from the replicated databases this thread
 * opened on LMDB. Every thread opens the same roots after `storage.migrateOnStart`, so they agree. A
 * root created later uses the configured engine, which `RECORD_LOCKS_CONFIGURED` requires to be
 * RocksDB; an LMDB database that only becomes replicated later is refused on its own by
 * `ensureRecordLockTransport`. Lists them only when config allows, so the default path walks no catalog.
 * Returns whether this call admitted them.
 */
export function admitClusterRecordLocks(listLmdbDatabases: () => readonly string[]): boolean {
	if (admitted || !RECORD_LOCKS_CONFIGURED) return false;
	const lmdbDatabases = listLmdbDatabases();
	admitted = true;
	const { enabled, refusal } = recordLockAdmission(RECORD_LOCKS_CONFIGURED, lmdbDatabases);
	RECORD_LOCKS_REFUSAL = refusal;
	if (refusal && isMainThread)
		logger.error?.(
			`replication.recordLocks requires every replicated database to be on RocksDB; cluster record locks stay disabled because these are opened on LMDB: ${lmdbDatabases.join(', ')}. A node upgraded in place from v4 keeps its existing .mdb databases on LMDB whatever storage.engine says; migrate them with storage.migrateOnStart and restart`
		);
	CLUSTER_RECORD_LOCKS_ENABLED = enabled;
	return enabled;
}
