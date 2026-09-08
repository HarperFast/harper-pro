import { getConfigObj } from '../core/config/configUtils.ts';
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
 */
const configured: unknown = getConfigObj()?.replication?.recordLocks;
// Only a real boolean `true` enables it; a truthy non-boolean (a YAML `1`, a quoted `"true"`) would
// leave the node advertising `recordLocks: 0` and registering the fail-closed transport, so warn
// rather than let an operator believe the switch is on.
if (configured !== undefined && configured !== true && configured !== false && configured)
	logger.warn?.(
		`replication.recordLocks is set to ${JSON.stringify(configured)}, which is not the boolean true; cluster record locks stay disabled`
	);
export const CLUSTER_RECORD_LOCKS_ENABLED: boolean = configured === true;
