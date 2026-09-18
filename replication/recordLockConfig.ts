import { getConfigObj } from '../core/config/configUtils.ts';
import * as env from '../core/utility/environment/environmentManager.js';
import { CONFIG_PARAMS } from '../core/utility/hdbTerms.ts';
import * as logger from '../core/utility/logging/harper_logger.js';

/**
 * `replication.recordLocks: true` admits this node to cluster-wide record locks (harper-pro#438). It
 * is an explicit opt-in because enabling it changes subscription placement — every subscription for a
 * database moves to the worker that coordinates the database's locks — which concentrates a
 * single-database cluster's inbound apply work on one worker. Off, nothing about replication changes
 * and a cluster-scoped `lock()` fails closed rather than silently arbitrating on one node.
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
let engineSupported = true;
if (configured === true) {
	const engine = process.env.HARPER_STORAGE_ENGINE || env.get(CONFIG_PARAMS.STORAGE_ENGINE);
	if (engine === 'lmdb') {
		engineSupported = false;
		logger.error?.(
			'replication.recordLocks requires the RocksDB storage engine; cluster record locks stay disabled on this LMDB node'
		);
	}
}
export const CLUSTER_RECORD_LOCKS_ENABLED: boolean = configured === true && engineSupported;
