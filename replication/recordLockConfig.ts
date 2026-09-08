import { getConfigObj } from '../core/config/configUtils.ts';

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
export const CLUSTER_RECORD_LOCKS_ENABLED: boolean = getConfigObj()?.replication?.recordLocks === true;
