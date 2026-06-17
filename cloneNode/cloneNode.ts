import { parseArgs } from 'node:util';
import { accessSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import yaml from 'yaml';
import { decode as cborDecode } from 'cbor-x';

import * as envMgr from '../core/utility/environment/environmentManager.js';
import * as logger from '../core/utility/logging/harper_logger.js';
import { isHdbInstalled } from '../core/utility/installation.js';
import { getConfiguration, flattenConfig, createConfigFile, updateConfigValue } from '../core/config/configUtils.js';
import { composeConfigFromEnv } from '../core/config/harperConfigEnvVars.ts';
import assignCMDENVVariables from '../core/utility/assignCmdEnvVariables.js';

import {
	SYSTEM_SCHEMA_NAME,
	CONFIG_PARAMS,
	OPERATIONS_ENUM,
	HDB_ROOT_DIR_NAME,
	HDB_CONFIG_FILE,
	DATABASES_DIR_NAME,
	CONFIG_PARAM_MAP,
	HARPER_CONFIG_FILE,
	LICENSE_KEY_DIR_NAME,
	JWT_ENUM,
} from '../core/utility/hdbTerms.ts';
import { fetchJWTKeyWithRetry } from './jwtKeyClone.ts';

/**
 * Environment Variables:
 *
 * Clone Methods:
 * This script supports two cloning approaches:
 * 1. Certificate-based: Uses pre-setup certs for authentication over WebSocket connections
 * 2. username/password or JWT token cloning: Uses credentials (username/password or token) with fetch calls between nodes
 *
 * Required (if not via CLI):
 * - HDB_LEADER_URL: URL of the leader node to clone from
 *
 * Required for username/password or JWT token cloning:
 * - HDB_LEADER_USERNAME + HDB_LEADER_PASSWORD: Admin credentials for username/password authentication
 * - HDB_LEADER_TOKEN: JWT authentication token for the leader node
 *
 * Optional:
 * - CLONE_SSH_KEYS: Clone SSH keys from leader (default: true)
 * - CLONE_JWT_KEYS: Clone JWT keys from leader (default: true)
 * - ALLOW_SELF_SIGNED: Allow self-signed certificates to be used for authentication (default: false)
 * - CLONE_SYNC_TIMEOUT: Sync timeout in milliseconds (default: 300000)
 * - REPLICATION_PORT: Port for replication
 * - FORCE_CLONE: Force clone even if node exists (default: false)
 * - ROOTPATH: Harper installation root path
 * - NODE_HOSTNAME: Hostname for this node
 *
 * rootPath, node_hostname, and replication.port can also be supplied via HARPER_SET_CONFIG
 * or HARPER_DEFAULT_CONFIG as a fallback when no CLI flag or dedicated env var is set, e.g.
 * HARPER_SET_CONFIG='{"rootPath":"/data/hdb","node_hostname":"node-a","replication":{"port":9933}}'.
 *
 * CLI Arguments:
 * Boolean flags are presence-based: include the flag to enable, omit to disable.
 * --leader-url: URL of the leader node to clone from
 * --leader-username: Admin username for credential-based authentication
 * --leader-password: Admin password for credential-based authentication
 * --rootpath: Harper installation root path
 * --node-hostname: Hostname for this node
 * --replication-port: Port for replication
 * --skip-sync-monitor: Skip monitoring sync status (default: false)
 * --sync-timeout: Sync timeout in milliseconds (default: 300000)
 * --skip-ssh-keys: Skip cloning SSH keys (default: false)
 * --skip-jwt-keys: Skip cloning JWT keys (default: false)
 * --force-clone: Force clone even if node exists (default: false)
 * --allow-self-signed: Allow self-signed certificates (default: false)
 */

const DEFAULT_SYNC_TIMEOUT_MS = 300000;
const DEFAULT_SYNC_CHECK_INTERVAL_MS = 3000;
const DEFAULT_REPLICATION_PORT = '9933';

const CONFIG_TO_EXCLUDE_FROM_CLONE = {
	clustering_nodename: true,
	clustering_leafserver_streams_path: true,
	clustering_tls_certificate: true,
	clustering_tls_privatekey: true,
	clustering_tls_certificateauthority: true,
	logging_file: true,
	logging_root: true,
	logging_rotation_path: true,
	operationsapi_network_domainsocket: true,
	operationsapi_tls_certificate: true,
	operationsapi_tls_privatekey: true,
	operationsapi_tls_certificateauthority: true,
	rootpath: true,
	storage_path: true,
	storage_audit_path: true,
	databases: true,
	mqtt_network_mtls_certificateauthority: true,
	componentsroot: true,
	tls_certificate: true,
	tls_privatekey: true,
	tls_certificateauthority: true,
	replication_hostname: true,
	replication_url: true,
	cloned: true,
	node_hostname: true,
};

type ParsedValues = {
	'leader-url'?: string;
	'leader-username'?: string;
	'leader-password'?: string;
	'leader-token'?: string;
	'rootpath'?: string;
	'node-hostname'?: string;
	'replication-port'?: string;
	'skip-sync-monitor'?: boolean;
	'sync-timeout'?: string;
	'skip-ssh-keys'?: boolean;
	'skip-jwt-keys'?: boolean;
	'force-clone'?: boolean;
	'allow-self-signed'?: boolean;
};

const { values } = parseArgs({
	options: {
		'leader-url': { type: 'string' },
		'leader-username': { type: 'string' },
		'leader-password': { type: 'string' },
		'leader-token': { type: 'string' },
		'rootpath': { type: 'string' },
		'node-hostname': { type: 'string' },
		'replication-port': { type: 'string' },
		'skip-sync-monitor': { type: 'boolean' },
		'sync-timeout': { type: 'string' },
		'skip-ssh-keys': { type: 'boolean' },
		'skip-jwt-keys': { type: 'boolean' },
		'force-clone': { type: 'boolean' },
		'allow-self-signed': { type: 'boolean' },
	},
	strict: false,
}) as { values: ParsedValues };

// Compose HARPER_DEFAULT_CONFIG / HARPER_SET_CONFIG so the config-shaped reads below can
// fall back to the JSON config env vars when no CLI flag or dedicated env var is set.
const composedConfig = composeConfigFromEnv();
const leaderURL: string = values['leader-url'] || process.env.HDB_LEADER_URL;
const leaderUsername: string = values['leader-username'] || process.env.HDB_LEADER_USERNAME;
const leaderPassword: string = values['leader-password'] || process.env.HDB_LEADER_PASSWORD;
const leaderToken: string = values['leader-token'] || process.env.HDB_LEADER_TOKEN;
const skipSyncMonitor: boolean = values['skip-sync-monitor'] ?? process.env.CLONE_SKIP_SYNC_MONITOR === 'true';
const syncTimeoutMs: number = Math.max(
	1,
	parseInt(values['sync-timeout'] || process.env.CLONE_SYNC_TIMEOUT, 10) || DEFAULT_SYNC_TIMEOUT_MS
);
// `replication.port` in HARPER_SET_CONFIG / HARPER_DEFAULT_CONFIG accepts both a numeric port
// and a `host:port` string; cloneNode treats `replicationPort` as a port number (substituted
// into the leader URL and written to REPLICATION_PORT), so strip any leading `host:`.
const composedReplicationPort = composedConfig.replication?.port;
const composedReplicationPortFallback =
	composedReplicationPort != null ? String(composedReplicationPort).split(':').pop() : undefined;
const replicationPort: string =
	values['replication-port'] || process.env.REPLICATION_PORT || composedReplicationPortFallback;
const skipSSHKeys: boolean = values['skip-ssh-keys'] ?? process.env.CLONE_SKIP_SSH_KEYS === 'true';
const skipJWTKeys: boolean = values['skip-jwt-keys'] ?? process.env.CLONE_SKIP_JWT_KEYS === 'true';
const forceClone: boolean = values['force-clone'] ?? process.env.FORCE_CLONE === 'true';
const allowSelfSigned: boolean = values['allow-self-signed'] ?? process.env.ALLOW_SELF_SIGNED === 'true';
const nodeHostname: string =
	values['node-hostname'] ||
	process.env.NODE_HOSTNAME ||
	process.env.REPLICATION_HOSTNAME ||
	composedConfig.node_hostname ||
	composedConfig.replication?.hostname;
let rootPath: string = values['rootpath'] || values['ROOTPATH'] || process.env.ROOTPATH || composedConfig.rootPath;
const usingCertAuth: boolean = !(leaderUsername && leaderPassword) && !leaderToken;
let harperLogger: any;
let leaderReplicationURL: string;
let hdbConfig: Record<string, any> = {};
let freshClone: boolean = false;

export async function cloneNode(): Promise<void> {
	// Clone using websockets with certificate-based auth, or with credential/token auth if provided
	log(`Starting clone node from leader: ${leaderURL} using ${usingCertAuth ? 'certificate' : 'credential'} auth`);

	// If a root path was provided, use it. Otherwise, check for existing install to get root path or start a fresh clone and generate a new root path.
	resolveRootPath();

	// Make sure rootPath is set in all the places that is could be needed.
	// This is especially important for local testing where multiple Harper versions are running on the same machine.
	envMgr.setHdbBasePath(rootPath);

	// Initial heuristic-based replication URL: convert http(s)→ws(s) and substitute the
	// configured (or default) replication port. This may be wrong against leaders that bind
	// the replication port as TLS only (e.g. Harper v4 default, which binds `securePort: 9933`
	// with no plain WS sibling). For credential/token auth we refine it below once we've fetched
	// the leader's config via HTTP; cert-auth has no other choice but to use this heuristic.
	leaderReplicationURL = leaderURL
		.replace('http://', 'ws://')
		.replace('https://', 'wss://')
		.replace(/:(\d+)/, `:${replicationPort || DEFAULT_REPLICATION_PORT}`);

	// Check to see if there is an existing config file to read additional config from
	const cfgPath: string = join(rootPath, HARPER_CONFIG_FILE);
	const oldCfgPath: string = join(rootPath, HDB_CONFIG_FILE);
	let harperConfigPath: string | undefined;
	if (pathExists(cfgPath)) {
		harperConfigPath = cfgPath;
		log(`Existing config file found at ${cfgPath}, reading config from this file`);
	} else if (pathExists(oldCfgPath)) {
		harperConfigPath = oldCfgPath;
		log(`Existing config file found at ${oldCfgPath}, reading config from this file`);
	} else {
		log('No existing config file found, starting with empty config');
	}

	if (harperConfigPath) {
		try {
			const yamlContent: string = readFileSync(harperConfigPath, 'utf8');
			const hdbConfigJson: Record<string, any> = yaml.parse(yamlContent);
			hdbConfig = flattenConfig(hdbConfigJson);
		} catch (err) {
			log(`Error reading existing config file ${harperConfigPath} on clone: ${err}`, 'error');
		}
	}

	// If not a fresh clone, and the existing config shows the instance is already cloned, skip clone process and start normally
	if (hdbConfig?.cloned && !forceClone) {
		log('Skipping clone, instance already marked as cloned. Starting Harper.');
		envMgr.initSync();
		const { main } = await import('../core/bin/run.js');
		return main();
	}

	if (!usingCertAuth) {
		// Request to leader to verify connectivity and credentials before proceeding with clone
		// Cannot check if cloning with WS - module initialization order prevents access to required variables
		await leaderRequest({ operation: OPERATIONS_ENUM.GET_STATUS });
	}

	// Install Harper if this is a fresh clone or if the system database does not exist
	const systemDBPath: string = getDBPath(SYSTEM_SCHEMA_NAME);
	const systemExists: boolean = pathExists(systemDBPath);
	if (freshClone || !systemExists) {
		await installHarper();
	}

	// Start Harper to prepare for clone operations
	const { main } = await import('../core/bin/run.js');
	await main();

	logger.initLogSettings();
	harperLogger = logger.loggerWithTag('cloneNode');

	// Get the config from the leader and write it to the existing local config file, excluding any parameters that should not be cloned
	const leaderConfigData = await cloneConfig();

	// Refine the leader replication URL using the leader's own config. This is the only way to
	// pick the right scheme (ws:// vs wss://) when bootstrapping against a leader whose
	// replication port is TLS-only — most notably v4 leaders, whose default config binds
	// `replication.securePort: 9933` with no plain WS sibling. The initial heuristic above
	// emits `ws://` which v4 silently refuses (TCP-level reset), so the v5 → v4 clone never
	// completes the set_node handshake.
	const refinedLeaderReplicationURL = deriveLeaderReplicationURL(leaderConfigData, leaderReplicationURL);
	if (refinedLeaderReplicationURL !== leaderReplicationURL) {
		log(
			`Adjusted leader replication URL from ${leaderReplicationURL} to ${refinedLeaderReplicationURL} based on leader config`
		);
		leaderReplicationURL = refinedLeaderReplicationURL;
	}

	// Clone applications that are deployed on the leader but not referenced in harper-config
	await cloneApplications();

	// Pre-create the leader's user databases (and any tables we don't already have locally) on
	// this clone *before* establishing replication. Replication subscriptions are only set up for
	// databases that already exist locally — see `forEachReplicatedDatabase` in
	// `replication/replicator.ts`, which iterates `databases` and only fires subscriptions for the
	// ones it finds. If we leave the user databases for the leader's incoming push to "create"
	// them, the v5 clone never opens an outgoing subscription to the leader and never asks for
	// the historical data. That manifests as the clone sitting at "Available never reached" with
	// `database 'data' does not exist` errors in the log, because the leader (especially v4) does
	// not push schema for user databases unless this side has explicitly subscribed.
	//
	// Doing this only matters for credential / token auth (HTTP `describe_all` available); cert
	// auth has no way to talk to the leader before replication is up, so we skip there and rely on
	// the existing self-bootstrap (cert-auth users are bootstrapping inside an already-clustered
	// environment that has the cluster CA chain).
	if (!usingCertAuth) {
		await cloneSchemas();
	}

	// Base set node request
	type SetNodeRequest = {
		operation: string;
		verify_tls: boolean;
		url: string;
		authorization?:
			| {
					username: string;
					password: string;
			  }
			| string;
	};

	const setNodeRequest: SetNodeRequest = {
		operation: OPERATIONS_ENUM.ADD_NODE,
		verify_tls: false, // set node cross-signs the cluster with harper self-signed certs
		url: leaderReplicationURL,
	};

	if (!usingCertAuth) {
		// If cloning using credential/token auth, we need to include the leader credentials in the set node request so that the leader can authenticate this node
		if (leaderToken) {
			setNodeRequest.authorization = 'Bearer ' + leaderToken;
		} else {
			setNodeRequest.authorization = {
				username: leaderUsername,
				password: leaderPassword,
			};
		}
	}

	// Restarting workers to ensure new configuration it loaded.
	log('Restarting workers to apply new configuration');
	const { restartWorkers } = await import('../core/server/threads/manageThreads.js');
	await restartWorkers();

	// Dynamically importing setNode because it was causing early usage of rootpath var install before it was initialized.
	const { setNode } = await import('../replication/setNode.js');

	// Set node will set up replication between this node and the leader,
	// which will trigger the sync of data including some system tables like users and roles.
	log('Sending set node request to leader to establish replication and trigger data sync');
	const setNodeResponse = await setNode(setNodeRequest);
	log(`Response from set node: ${setNodeResponse}`);

	try {
		await cloneJWTKeys();
	} catch (err) {
		// A node without the leader's JWT signing keys cannot issue or validate tokens, so the clone is
		// not viable. Mirror the unconfirmed-sync handling below: keep Harper running so get_status stays
		// queryable, publish Unavailable, clear the cloned flag so a subsequent start retries the clone,
		// and stop before finalizing.
		const { set: setStatus } = await import('../core/server/status/index.js');
		try {
			await setStatus({ id: 'availability', status: 'Unavailable' });
		} catch (statusErr) {
			log(`Failed to set availability status to Unavailable: ${statusErr}`, 'error');
		}
		updateConfigValue(CONFIG_PARAMS.CLONED, false);
		log(
			`Clone from leader node ${leaderURL} failed to obtain JWT signing keys (${err}); node is running but Unavailable and not marked as cloned`,
			'error'
		);
		return;
	}

	await cloneSSHKeys();

	// Monitor synchronization after cloning. Only finalize the clone (mark it cloned, log complete)
	// once sync is confirmed and availability has been published as Available — a timeout or failure
	// must not be treated as success.
	const syncOutcome = await monitorSync();
	if (syncOutcome === 'failed') {
		// Leave Harper running so get_status stays queryable for the control plane (availability is
		// now Unavailable). Throwing here would propagate to bin/harper.js and exit the already-started
		// process. Explicitly clear the cloned flag rather than just skipping the write: on a forced
		// reclone, cloneConfig() has already carried the previous `cloned: true` into the rewritten
		// config, so a bare return would leave it set and the next non-forced start would skip cloning
		// despite the unconfirmed sync. Clearing it ensures a subsequent start retries the clone.
		updateConfigValue(CONFIG_PARAMS.CLONED, false);
		log(
			`Clone from leader node ${leaderURL} did not complete synchronization; node is running but Unavailable and not marked as cloned`,
			'error'
		);
		return;
	}

	// Delete clone-temp-admin only after monitorSync() so that the account remains valid while
	// the leader establishes replication and syncs real users. Deleting it earlier leaves the
	// node with no users during setNode(), which prevents replication from being established.
	// Runs on retry too (when systemExists but cloned not yet set) via !hdbConfig?.cloned.
	if ((usingCertAuth || leaderToken) && (!systemExists || !hdbConfig?.cloned)) {
		try {
			const { databases } = await import('../core/resources/databases.js');
			// Only delete clone-temp-admin if it actually exists. If install used CLI/env args
			// that supplied a real admin username (e.g. integration tests pass
			// --HDB_ADMIN_USERNAME=admin), `clone-temp-admin` was never created and there is
			// nothing to clean up — skip the delete entirely.
			const existing = await databases.system.hdb_user.get('clone-temp-admin');
			if (existing) {
				// Wait until at least one non-clone-temp-admin user is present (replicated from leader)
				// before deleting, so the node still has a super_user available for local-auth.
				const waitDeadline = Date.now() + syncTimeoutMs;
				while (Date.now() < waitDeadline) {
					let foundReplicatedUser = false;
					try {
						for await (const user of databases.system.hdb_user.search([])) {
							if (user?.username && user.username !== 'clone-temp-admin') {
								foundReplicatedUser = true;
								break;
							}
						}
					} catch (err) {
						log(`Error scanning hdb_user while waiting for replicated user: ${err}`, 'error');
					}
					if (foundReplicatedUser) break;
					await sleep(200);
				}
				await databases.system.hdb_user.delete('clone-temp-admin');
			}
		} catch (err) {
			log(`Warning: failed to delete clone-temp-admin: ${err}`, 'error');
		}
	}

	// Set a config value to indicate that this node has been cloned, which can be used by other processes to check clone status and prevent duplicate cloning
	updateConfigValue(CONFIG_PARAMS.CLONED, true);

	log(`Clone from leader node ${leaderURL} complete`);
}

/**
 * Result of monitoring clone synchronization.
 * - `synced`: sync was confirmed and `availability` was published as Available.
 * - `skipped`: sync monitoring was disabled (skip-sync-monitor); `availability` is left untouched.
 * - `failed`: sync was not confirmed (timeout, missing targets, or a failed status write);
 *   `availability` is left Unavailable and the node must not be marked as cloned.
 */
type SyncOutcome = 'synced' | 'skipped' | 'failed';

/**
 * Monitors database synchronization after cloning and drives this node's `availability` status.
 *
 * `availability` is a cooperative, multi-writer status whose contract is owned by core; this is the
 * clone producer upholding it. It is published as Unavailable up front so `get_status` always
 * carries a definite signal for the control plane — never an absent field — and is only flipped to
 * Available once sync is confirmed and that write succeeds. On any failure it is left Unavailable.
 *
 * Polls at regular intervals until sync completes or the timeout is reached.
 */
async function monitorSync(): Promise<SyncOutcome> {
	const { set: setStatus } = await import('../core/server/status/index.js');

	if (skipSyncMonitor) {
		// The operator opted out of the sync gate, so the clone is declared ready. Publish Available
		// (best-effort) — this also clears any Unavailable persisted by a prior failed attempt, since
		// hdb_status is not replicated and survives restarts — keeping availability consistent with the
		// cloned flag the caller sets for this outcome.
		log('Skipping sync monitor (skip-sync-monitor); marking node Available without verifying sync');
		try {
			await setStatus({ id: 'availability', status: 'Available' });
		} catch (err) {
			log(`Failed to set availability status to Available: ${err}`, 'error');
		}
		return 'skipped';
	}

	const { clusterStatus } = await import('../replication/clusterStatus.js');

	// The node is not ready to serve traffic until the clone has caught up with the leader. Publish
	// Unavailable up front so get_status always carries a definite availability signal for the whole
	// sync wait. Best-effort: a failed write here must not abort the clone (the loop still runs and
	// publishes Available on success).
	try {
		await setStatus({ id: 'availability', status: 'Unavailable' });
	} catch (err) {
		log(`Failed to set availability status to Unavailable: ${err}`, 'error');
	}

	// Test/diagnostic hook (not a user-facing option): deterministically exercise the
	// unconfirmed-sync failure path. Loopback replication is too fast and bidirectional to force a
	// real sync timeout in tests, so this lets the failure-branch behavior — stay Unavailable, do not
	// mark cloned, keep the node running — be asserted deterministically.
	if (process.env.CLONE_SIMULATE_SYNC_FAILURE === 'true') {
		log('CLONE_SIMULATE_SYNC_FAILURE set; treating clone sync as unconfirmed', 'error');
		return 'failed';
	}

	// Get last updated record timestamps for all DB and write to file
	// These values can be used for checking when the clone replication has caught up with the leader
	const targetTimestamps = await getLastUpdatedRecord();
	if (!targetTimestamps || Object.keys(targetTimestamps).length === 0) {
		log('No target timestamps available to check synchronization status; leaving availability Unavailable', 'error');
		return 'failed';
	}

	log(
		`Starting to monitor sync status. Will check every ${DEFAULT_SYNC_CHECK_INTERVAL_MS}ms for up to ${Math.round(syncTimeoutMs / 60000)} minutes`
	);

	const timeoutAt: number = Date.now() + syncTimeoutMs;
	let loopCount: number = 0;

	while (Date.now() < timeoutAt) {
		try {
			const syncComplete = await checkSyncStatus(targetTimestamps, clusterStatus);

			if (syncComplete) {
				log('All databases synchronized');

				// Only report Available — and let the caller finalize the clone — once the status
				// write itself succeeds. A failed write must not be treated as a successful sync,
				// otherwise the node would be marked cloned without a readiness signal.
				try {
					await setStatus({ id: 'availability', status: 'Available' });
				} catch (err) {
					log(`Synchronized but failed to set availability to Available: ${err}; leaving Unavailable`, 'error');
					return 'failed';
				}

				return 'synced';
			}

			// Log every other iteration to reduce noise
			if (loopCount % 2 === 0) {
				log(`Sync incomplete, retrying in ${DEFAULT_SYNC_CHECK_INTERVAL_MS}ms`);
			}

			loopCount++;
			await sleep(DEFAULT_SYNC_CHECK_INTERVAL_MS);
		} catch (err) {
			log(`Error checking sync status: ${err}`, 'error');
			await sleep(DEFAULT_SYNC_CHECK_INTERVAL_MS); // Still wait on error
		}
	}

	log(
		`Databases did not synchronize within ${Math.round(syncTimeoutMs / 60000)} minutes; leaving availability Unavailable and not marking node as cloned`,
		'error'
	);
	return 'failed';
}

/**
 * Check if all databases are synchronized by comparing timestamps
 * Compares the most recent timestamp in each local database against the target timestamps from the leader
 * @param {Object} targetTimestamps - Target timestamps to check against
 * @param clusterStatus - Function to get the current cluster status, which includes replication status and timestamps for each database connection
 * @returns {Promise<boolean>} - True if all databases are synchronized
 */
async function checkSyncStatus(
	targetTimestamps: Record<string, number>,
	clusterStatus: () => Promise<any>
): Promise<boolean> {
	const clusterResponse = await clusterStatus();
	log(`clone sync check cluster status response: ${clusterResponse}`, 'debug');

	if (!clusterResponse) {
		log('No cluster status response received for clone, will wait and retry');
		return false;
	}

	if (!clusterResponse.connections?.length) {
		log('No connections found in cluster status response for clone, will wait and retry');
		return false;
	}

	// Find the leader replication connection
	const leaderConnection = clusterResponse.connections.find((conn) => conn.url === leaderReplicationURL);

	if (!leaderConnection) {
		log('No connection found matching leader replication URL, will wait and retry');
		return false;
	}

	if (!leaderConnection.database_sockets?.length) {
		log(`No database sockets found for connection leader ${leaderConnection.name}`, 'debug');
		return false;
	}

	// Check sync status for each database socket
	for (const socket of leaderConnection.database_sockets) {
		const dbName = socket.database;
		const targetTime = targetTimestamps[dbName];

		// Skip if no target time for this database
		if (!targetTime) {
			log(`Database ${dbName}: No target timestamp, skipping sync check`, 'debug');
			continue;
		}

		// Raw version timestamp from RECEIVED_VERSION_POSITION (high-precision float64)
		// This preserves sub-millisecond precision needed for accurate sync comparison
		const receivedVersion = socket.lastReceivedVersion;

		if (!receivedVersion) {
			log(`No lastReceivedVersion data received yet for database ${dbName}`, 'debug');
			return false;
		}

		if (receivedVersion < targetTime) {
			log(
				`Database ${dbName}: Not yet synchronized (received: ${receivedVersion}, target: ${targetTime}, gap: ${targetTime - receivedVersion}ms)`
			);
			return false;
		}

		log(`Database ${dbName}: Synchronized`, 'debug');
	}

	return true;
}

/**
 * Will loop through a system describe and a describeAll to compare the last updated record for each table
 * and record the most recent timestamp for each database in a JSON file.
 * @returns {Promise<void>}
 */
async function getLastUpdatedRecord(): Promise<Record<string, number>> {
	log('Getting last updated record timestamp for all database', 'debug');
	const lastUpdated: Record<string, number> = {};
	const systemDb: Record<string, any> = await leaderRequest({ operation: 'describe_database', database: 'system' });
	lastUpdated['system'] = findMostRecentTimestamp(systemDb);

	const allDb: Record<string, any> = await leaderRequest({ operation: 'describe_all' });
	for (const db in allDb) {
		// requestId is part of the describe response so we ignore it
		if (typeof allDb[db] !== 'object') continue;
		lastUpdated[db] = findMostRecentTimestamp(allDb[db]);
	}

	const lastUpdatedFilePath: string = join(rootPath, 'tmp', 'lastUpdated.json');
	log(`Writing last updated database timestamps to: ${lastUpdatedFilePath}`, 'debug');
	writeJsonSync(lastUpdatedFilePath, lastUpdated);

	return lastUpdated;
}

/**
 * Find the most recent last_updated_record timestamp across all tables in a database
 * @param {Object} dbObj - Database object or describe response containing tables
 * @returns {number} - Most recent timestamp, or 0 if none found
 */
function findMostRecentTimestamp(dbObj: Record<string, any>): number {
	let mostRecent = 0;
	for (const table in dbObj) {
		const tableObj = dbObj[table];
		// requestId is part of the describe response so we ignore it
		if (typeof tableObj !== 'object' || tableObj == null) continue;
		if (tableObj.last_updated_record > mostRecent) {
			mostRecent = tableObj.last_updated_record;
		}
	}

	return mostRecent;
}

/**
 * Clones SSH keys from the leader node by requesting a list of keys and then fetching each key's data to add to this node.
 */
async function cloneSSHKeys() {
	if (skipSSHKeys) return;

	const { addSSHKey } = await import('../security/sshKeyOperations.js');
	try {
		const keys: any = await leaderRequest({ operation: 'list_ssh_keys' });
		if (!keys?.length) {
			log('No SSH keys found on leader node to clone');
			return;
		}

		for (const keyName of keys) {
			log('Cloning SSH key:', keyName.name);
			const keyData: any = await leaderRequest({
				operation: 'get_ssh_key',
				name: keyName.name,
			});

			await addSSHKey(keyData);
		}
	} catch (err) {
		log(`Error cloning SSH keys: ${err}`, 'error');
	}
}

/**
 * Clones JWT keys from the leader node by requesting each key's data and writing it to the local file system.
 */
async function cloneJWTKeys(): Promise<void> {
	if (skipJWTKeys) return;

	log('Cloning JWT keys');
	const keysDir = join(rootPath, LICENSE_KEY_DIR_NAME);

	// Fetch all three keys before writing any. A partial write — say the private key lands but the
	// passphrase fetch fails — leaves the node unable to read its key set at all (getJWTRSAKeys needs
	// all three), which is harder to diagnose than a clean failure. fetchJWTKeyWithRetry rides out
	// transient leader hiccups and throws if a key can't be obtained, so the caller can contain a
	// non-viable clone rather than finalizing it.
	const publicKey = await fetchJWTKeyWithRetry(
		() => leaderRequest({ operation: 'get_key', name: '.jwtPublic' }),
		'.jwtPublic'
	);
	const privateKey = await fetchJWTKeyWithRetry(
		() => leaderRequest({ operation: 'get_key', name: '.jwtPrivate' }),
		'.jwtPrivate'
	);
	const passphrase = await fetchJWTKeyWithRetry(
		() => leaderRequest({ operation: 'get_key', name: '.jwtPass' }),
		'.jwtPass'
	);

	// Ensure the keys dir exists before writing — a cloned node normally has it from its own install,
	// but don't assume it (a fresh clone path, or a wiped dir, would otherwise fail with ENOENT).
	mkdirSync(keysDir, { recursive: true });
	writeFileSync(join(keysDir, JWT_ENUM.JWT_PUBLIC_KEY_NAME), publicKey);
	writeFileSync(join(keysDir, JWT_ENUM.JWT_PRIVATE_KEY_NAME), privateKey);
	writeFileSync(join(keysDir, JWT_ENUM.JWT_PASSPHRASE_NAME), passphrase);

	// Harper is already running by this point, so the operations API may have served an early Bearer-auth
	// request and cached the install-generated JWT keys in-process. Those just got overwritten on disk;
	// drop the cache so the next token verify/sign reads the cloned leader keys instead of finishing the
	// clone Available while still authing with the pre-clone key set. Dynamically imported to avoid the
	// module's load-time env.initSync() running before rootPath is initialized.
	const { clearJWTRSAKeysCache } = await import('../core/security/tokenAuthentication.js');
	clearJWTRSAKeysCache();
}

/**
 * Extract just a port number from a Harper config port value, which may be either a bare port
 * (number/string) or a `host:port` string. Returns undefined for null/undefined/unparseable values.
 */
function extractPort(value: unknown): number | undefined {
	if (value === null || value === undefined || value === '') return undefined;
	const str = String(value);
	const colon = str.lastIndexOf(':');
	const portPart = colon >= 0 ? str.slice(colon + 1) : str;
	const port = parseInt(portPart, 10);
	return Number.isFinite(port) ? port : undefined;
}

/**
 * Pick the correct WebSocket URL for replication against the leader, given the leader's own
 * `get_configuration` response. v5 nodes that use `replication.port` (plain WS) and v4 nodes
 * that use `replication.securePort` (WSS) need different schemes; the previous heuristic
 * always emitted `ws://` against http URLs, which silently fails against v4 because v4 binds
 * 9933 as TLS only and the WS handshake gets cut at TCP level.
 *
 * Precedence:
 *   1. Explicit override via `HDB_LEADER_REPLICATION_URL`.
 *   2. The leader's own `replication.url` if it explicitly set one.
 *   3. Derived from the leader's `replication.port` / `replication.securePort` and the leader's
 *      hostname. If both ports are present we prefer the secure port (matches `connect` behavior
 *      on the rest of the cluster). `REPLICATION_PORT` from this node's env, if set, overrides
 *      the port number but not the scheme decision.
 *   4. Falls back to whatever caller already computed (the http→ws heuristic).
 */
function deriveLeaderReplicationURL(leaderConfig: Record<string, any> | undefined, fallback: string): string {
	const explicit = process.env.HDB_LEADER_REPLICATION_URL;
	if (explicit) return explicit;

	const repl = leaderConfig?.replication ?? {};
	if (typeof repl.url === 'string' && repl.url) return repl.url;

	const securePort = extractPort(repl.securePort);
	const plainPort = extractPort(repl.port);
	const userOverridePort = extractPort(replicationPort);

	let scheme: 'ws' | 'wss' | undefined;
	let port: number | undefined;
	if (securePort != null) {
		scheme = 'wss';
		port = userOverridePort ?? securePort;
	} else if (plainPort != null) {
		scheme = 'ws';
		port = userOverridePort ?? plainPort;
	}

	if (!scheme || port == null) return fallback;

	let hostname: string;
	try {
		hostname = new URL(leaderURL).hostname;
	} catch {
		return fallback;
	}
	return `${scheme}://${hostname}:${port}`;
}

async function cloneConfig(): Promise<Record<string, any>> {
	log('Cloning config from leader');
	const leaderConfigData = await leaderRequest({ operation: OPERATIONS_ENUM.GET_CONFIGURATION });
	if (!leaderConfigData.hasOwnProperty('rootPath')) {
		throw new Error('Leader config data check failed: rootPath is missing from leader config response');
	}

	// Build base configuration with node-specific settings
	const configData: Record<string, any> = {
		rootpath: rootPath,
		node_hostname: nodeHostname,
	};

	if (replicationPort) {
		configData[CONFIG_PARAMS.REPLICATION_PORT] = replicationPort;
	}

	const flattenedLeaderConfig: Record<string, any> = flattenConfig(leaderConfigData);
	for (const [param, value] of Object.entries(flattenedLeaderConfig)) {
		// Skip objects (except arrays) and explicitly excluded parameters
		const isNonArrayObject = value !== null && typeof value === 'object' && !Array.isArray(value);
		if (isNonArrayObject || CONFIG_TO_EXCLUDE_FROM_CLONE[param]) {
			continue;
		}

		// Skip component packages/ports that reference local leader paths
		if ((param.includes('_package') || param.includes('_port')) && value?.includes?.('hdb/components')) {
			continue;
		}

		// Only add config if not already present in local config
		if (!hdbConfig[param]) {
			configData[param] = flattenedLeaderConfig[param];
		}
	}

	// Override with local config values (excluding nested objects, but including databases array)
	for (const [param, value] of Object.entries(hdbConfig)) {
		const isNonArrayObject = param !== 'databases' && typeof value === 'object' && !Array.isArray(value);
		if (isNonArrayObject) {
			continue;
		}

		configData[param] = value;
	}

	// Apply command-line and environment variable overrides
	const cliArgs = assignCMDENVVariables(Object.keys(CONFIG_PARAM_MAP), true);
	Object.assign(configData, cliArgs);

	// Write final configuration to file
	createConfigFile(configData, true);

	return leaderConfigData;
}

/**
 * Clones applications from the leader that are deployed to the applications directory but not referenced in harper-config.
 * Applications referenced in harper-config are handled by normal config cloning and reinstalled on startup.
 */
async function cloneApplications(): Promise<void> {
	log('Cloning filesystem-only applications from leader');

	let applicationsResponse: Record<string, any>;
	try {
		applicationsResponse = await leaderRequest({ operation: OPERATIONS_ENUM.GET_COMPONENTS });
	} catch (err) {
		log(`Failed to get applications from leader: ${err}`, 'error');
		return;
	}

	const entries: Array<Record<string, any>> = applicationsResponse?.entries ?? [];
	// filesystem-only applications will not have a `package` property
	const filesystemOnlyApplications = entries.filter((entry) => Array.isArray(entry.entries) && !entry.package);

	if (filesystemOnlyApplications.length === 0) {
		log('No filesystem-only applications found on leader to clone');
		return;
	}

	log(`Cloning ${filesystemOnlyApplications.length} application(s) not referenced in harper-config`);

	const { Application, prepareApplication } = await import('../core/components/Application.ts');

	for (const entry of filesystemOnlyApplications) {
		const applicationName: string = entry.name;
		log(`Cloning application: ${applicationName}`);
		try {
			const packageResponse = await leaderRequest({
				operation: OPERATIONS_ENUM.PACKAGE_COMPONENT,
				project: applicationName,
				skip_node_modules: true,
			});

			const application = new Application({
				name: applicationName,
				payload: packageResponse.payload,
			});

			await prepareApplication(application);
			log(`Successfully cloned application: ${applicationName}`);
		} catch (err) {
			log(`Failed to clone application '${applicationName}': ${err}`, 'error');
		}
	}
}

/**
 * Pre-create the leader's user databases and tables on this clone so the replication subsystem
 * has them registered locally when `setNode` is called. Without this, the v5 clone never sets
 * up an outgoing subscription for the leader's data databases (replication only iterates over
 * databases that already exist in the local `databases` map) and the full-table-copy from the
 * leader silently never starts. This is the only thing standing between cloneNode and a
 * working bootstrap from a v4 leader, where the leader does not push schemas spontaneously.
 *
 * The system database is intentionally skipped — it already exists on this node from
 * `installHarper`, and its tables are managed by harper itself. Tables we already have locally
 * are also left alone so a re-run of cloneNode is safe.
 */
async function cloneSchemas(): Promise<void> {
	log('Cloning database/table schemas from leader');
	let allDb: Record<string, any>;
	try {
		allDb = await leaderRequest({ operation: OPERATIONS_ENUM.DESCRIBE_ALL });
	} catch (err) {
		log(`Failed to describe leader databases for schema clone: ${err}`, 'error');
		return;
	}
	if (!allDb || typeof allDb !== 'object') {
		log(`Leader returned unexpected describe_all shape (${typeof allDb}); skipping schema clone`, 'error');
		return;
	}

	// `describe_all` returns `{ databaseName: { tableName: { name, schema, attributes, hash_attribute, ... } } }`,
	// plus a `requestId` sibling we need to skip.
	const { createSchema, createTable } = await import('../core/dataLayer/schema.js');
	const { databases } = await import('../core/resources/databases.js');

	// Filter by this node's `replication.databases` so we don't materialize empty databases the
	// clone isn't even subscribing to. Matches the gating used by `shouldReplicateFromNode` in
	// `replication/knownNodes.ts`: `undefined` or `'*'` accept everything; an array accepts only
	// the names it lists (objects with `.name` are sharded-database entries).
	const databaseReplications = envMgr.get(CONFIG_PARAMS.REPLICATION_DATABASES);
	const isReplicatedDatabase = (dbName: string): boolean => {
		if (!databaseReplications || databaseReplications === '*') return true;
		if (!Array.isArray(databaseReplications)) return true;
		return databaseReplications.some((entry: any) =>
			typeof entry === 'string' ? entry === dbName : entry?.name === dbName
		);
	};

	for (const dbName of Object.keys(allDb)) {
		const dbDescribe = allDb[dbName];
		if (!dbDescribe || typeof dbDescribe !== 'object' || dbName === SYSTEM_SCHEMA_NAME) continue;
		if (!isReplicatedDatabase(dbName)) {
			log(`Skipping schema pre-create for '${dbName}' (not in replication.databases)`, 'debug');
			continue;
		}

		if (!databases[dbName]) {
			try {
				await createSchema({ database: dbName, operation: OPERATIONS_ENUM.CREATE_DATABASE });
				log(`Pre-created database '${dbName}' from leader schema`);
			} catch (err) {
				// `already exists` is fine; anything else we surface and continue so the other
				// databases still get a chance.
				const msg = (err as Error)?.message ?? String(err);
				if (!/already exists|database.*exists/i.test(msg)) {
					log(`Failed to pre-create database '${dbName}': ${msg}`, 'error');
					continue;
				}
			}
		}

		for (const tableName of Object.keys(dbDescribe)) {
			const tableDesc = dbDescribe[tableName];
			if (!tableDesc || typeof tableDesc !== 'object') continue;
			if (databases[dbName]?.[tableName]) continue;

			// describe_all `attributes` entries use `{ attribute, type, is_primary_key }` — translate to
			// create_table's `{ name, type, isPrimaryKey }` shape. Skip server-managed attributes
			// (created/updated timestamp columns are auto-added).
			const attributes = (tableDesc.attributes ?? [])
				.filter((att: any) => !att.assigned_created_time && !att.assigned_updated_time)
				.map((att: any) => ({
					name: att.attribute ?? att.name,
					type: att.type,
					isPrimaryKey: att.is_primary_key ?? att.isPrimaryKey,
				}));

			const primaryKey = tableDesc.hash_attribute ?? attributes.find((a: any) => a.isPrimaryKey)?.name ?? 'id';

			try {
				await createTable({
					database: dbName,
					table: tableName,
					primary_key: primaryKey,
					attributes,
					operation: OPERATIONS_ENUM.CREATE_TABLE,
				});
				log(`Pre-created table '${dbName}.${tableName}' from leader schema`);
			} catch (err) {
				const msg = (err as Error)?.message ?? String(err);
				if (!/already exists|table.*exists/i.test(msg)) {
					log(`Failed to pre-create table '${dbName}.${tableName}': ${msg}`, 'error');
				}
			}
		}
	}
}

/**
 * Send a request to the leader node for the given operation, using either WebSockets or HTTP based on the useWS flag
 * @param operation
 */
async function leaderRequest(operation: { operation: string; [key: string]: any }): Promise<Record<string, any>> {
	if (usingCertAuth) {
		// Dynamically importing the replicator module because it was causing early import of rootpath var on
		// install before it was initialized.
		const { sendOperationToNode } = await import('../replication/replicator.js');
		return sendOperationToNode({ url: leaderReplicationURL }, operation, {
			rejectUnauthorized: !allowSelfSigned,
		});
	}

	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		'Accept': 'application/cbor',
	};

	if (leaderToken) {
		headers.Authorization = `Bearer ${leaderToken}`;
	} else {
		headers.Authorization = `Basic ${Buffer.from(`${leaderUsername}:${leaderPassword}`).toString('base64')}`;
	}

	const body = JSON.stringify(operation);
	const url = new URL(leaderURL);
	const isHttps = url.protocol === 'https:';
	const port = url.port ? parseInt(url.port, 10) : isHttps ? 443 : 80;
	const path = url.pathname + url.search;
	const requestHeaders = { ...headers, 'Content-Length': Buffer.byteLength(body) };

	const { statusCode, statusMessage, contentType, responseBody } = await new Promise<{
		statusCode: number;
		statusMessage: string;
		contentType: string;
		responseBody: Buffer;
	}>((resolve, reject) => {
		const callback = (res: import('node:http').IncomingMessage) => {
			const chunks: Buffer[] = [];
			res.on('data', (chunk: Buffer) => chunks.push(chunk));
			res.on('end', () =>
				resolve({
					statusCode: res.statusCode!,
					statusMessage: res.statusMessage!,
					contentType: (res.headers['content-type'] as string) ?? '',
					responseBody: Buffer.concat(chunks),
				})
			);
			res.on('error', reject);
		};
		const req = isHttps
			? httpsRequest(
					{
						hostname: url.hostname,
						port,
						path,
						method: 'POST',
						headers: requestHeaders,
						rejectUnauthorized: !allowSelfSigned,
					},
					callback
				)
			: httpRequest({ hostname: url.hostname, port, path, method: 'POST', headers: requestHeaders }, callback);
		req.on('error', reject);
		req.write(body);
		req.end();
	});

	if (statusCode < 200 || statusCode >= 300) {
		throw new Error(`Leader request failed: ${statusCode} ${statusMessage}`);
	}

	if (contentType.includes('application/cbor')) {
		return cborDecode(responseBody);
	}
	return JSON.parse(responseBody.toString('utf8'));
}

/**
 * Log a message to the console and to the Harper logger if it is initialized
 * @param message
 * @param level - 'notify' for general messages, 'error' for error messages
 */
type LogLevel = 'notify' | 'error' | 'debug';
function log(message: string, level: LogLevel = 'notify'): void {
	const isError = level === 'error';
	const isDebug = level === 'debug';
	if (harperLogger) {
		if (isError) harperLogger.error?.(message);
		else if (isDebug) {
			harperLogger.debug?.(message);
			return;
		} else harperLogger.notify?.(message);
	}

	if (isError) console.error(message);
	else console.log(message);
}

/**
 * Installs Harper as the base for the clone operation
 */
async function installHarper(): Promise<void> {
	log(`Clone installing Harper at root path: ${rootPath}`);

	if (usingCertAuth || leaderToken) {
		// Set temporary admin credentials if cloning without username/password to allow installation to complete.
		// These values will be replaced during the clone process after syncing system tables from the leader.
		process.env.HDB_ADMIN_USERNAME = 'clone-temp-admin';
		process.env.HDB_ADMIN_PASSWORD = randomBytes(20).toString('base64').slice(0, 10);
	} else {
		// Use provided leader credentials for this installation
		process.env.HDB_ADMIN_USERNAME = leaderUsername;
		process.env.HDB_ADMIN_PASSWORD = leaderPassword;
	}
	process.env.NODE_HOSTNAME = nodeHostname;
	process.env.TC_AGREEMENT = 'yes';
	process.env.ROOTPATH = rootPath;

	const { install, setIgnoreExisting } = await import('../core/utility/install/installer.js');

	setIgnoreExisting(true);
	await install();
}

/**
 * Check if a file or directory exists at the given path
 * @param path
 */
function pathExists(path: string): boolean {
	try {
		accessSync(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Write the given data as JSON to a file at the specified path
 * @param path
 * @param data
 */
function writeJsonSync(path: string, data: any): void {
	try {
		// Create directory if it doesn't exist
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
	} catch (err) {
		log(`Error writing JSON to ${path}: ${err}`, 'error');
	}
}

/**
 * Get the database path for a given database name
 * Checks to see if there is any custom DB pathing else uses the default storage path
 * @param dbName
 */
function getDBPath(dbName: string): string {
	const dbConfig = envMgr.get(CONFIG_PARAMS.DATABASES)?.[dbName];
	return dbConfig?.path || envMgr.get(CONFIG_PARAMS.STORAGE_PATH) || join(rootPath, DATABASES_DIR_NAME);
}

/**
 * Determines the root path for the Harper installation based on the following order of precedence:
 * 1. ROOTPATH provided via CLI or environment variable
 * 2. Existing Harper installation root path (if found)
 * 3. Default root path at ~/harperdb
 * If an existing root path is found but does not exist on the filesystem, it will fall back to a fresh clone with a new root path.
 */
function resolveRootPath(): void {
	if (rootPath) {
		if (pathExists(rootPath)) {
			log(`Using root path: ${rootPath}`);
		} else {
			log(`Root path ${rootPath} does not exist, starting fresh clone`);
			freshClone = true;
		}
	} else if (isHdbInstalled(envMgr, logger)) {
		log('Existing Harper install found, getting default root path from config');
		try {
			// getConfiguration will get the config file name from the boot properties file and then read the harperdb-config file
			const config: Record<string, any> = getConfiguration();
			rootPath = config[CONFIG_PARAMS.ROOTPATH];
		} catch (err) {
			throw new Error(
				`There was an error setting the clone default root path. Please set ROOTPATH using an environment or CLI variable. ${err}`
			);
		}
	} else {
		log('No Harper install found, starting fresh clone');
		freshClone = true;
		rootPath = join(homedir(), HDB_ROOT_DIR_NAME);
		log(`Using default root path: ${rootPath}`);
	}
}
