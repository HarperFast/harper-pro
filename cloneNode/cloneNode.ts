import { parseArgs } from 'node:util';
import { accessSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import yaml from 'yaml';
import https from 'https';

import envMgr from '../core/utility/environment/environmentManager.js';
import * as logger from '../core/utility/logging/harper_logger.js';
import { isHdbInstalled } from '../core/utility/installation.js';
import { getConfiguration, flattenConfig, createConfigFile, updateConfigValue } from '../core/config/configUtils.js';
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
	JWT_ENUM
} from '../core/utility/hdbTerms.ts';

/**
 * Environment Variables:
 *
 * Clone Methods:
 * This script supports two cloning approaches:
 * 1. Certificate-based: Uses pre-setup certs for authentication over WebSocket connections
 * 2. set_node cloning: Uses credentials (username/password) with fetch calls between nodes
 *
 * Required (if not via CLI):
 * - HDB_LEADER_URL: URL of the leader node to clone from
 *
 * Required for set_node cloning:
 * - HDB_LEADER_USERNAME: Admin username for credential-based authentication
 * - HDB_LEADER_PASSWORD: Admin password for credential-based authentication
 *
 * Optional:
 * - CLONE_SSH_KEYS: Clone SSH keys from leader (default: true)
 * - CLONE_JWT_KEYS: Clone JWT keys from leader (default: true)
 * - ALLOW_SELF_SIGNED: Allow self-signed certificates to be used for authentication (default: false)
 * - CLONE_NODE_UPDATE_STATUS: Update node status during clone (default: false)
 * - CLONE_SYNC_TIMEOUT: Sync timeout in milliseconds (default: 30000)
 * - REPLICATION_PORT: Port for replication
 * - FORCE_CLONE: Force clone even if node exists (default: false)
 * - ROOTPATH: HarperDB installation root path
 * - NODE_HOSTNAME: Hostname for this node
 *
 * CLI Arguments:
 * Boolean flags are presence-based: include the flag to enable, omit to disable.
 * --leader-url: URL of the leader node to clone from
 * --leader-username: Admin username for credential-based authentication
 * --leader-password: Admin password for credential-based authentication
 * --rootpath: HarperDB installation root path
 * --node-hostname: Hostname for this node
 * --replication-port: Port for replication
 * --skip-sync-monitor: Skip monitoring sync status (default: false)
 * --sync-timeout: Sync timeout in milliseconds (default: 30000)
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

const leaderURL: string = values['leader-url'] || process.env.HDB_LEADER_URL;
const leaderUsername: string = values['leader-username'] || process.env.HDB_LEADER_USERNAME;
const leaderPassword: string = values['leader-password'] || process.env.HDB_LEADER_PASSWORD;
const skipSyncMonitor: boolean = values['skip-sync-monitor'] ?? process.env.CLONE_SKIP_SYNC_MONITOR === 'true';
const syncTimeoutMs: number = Math.max(
	1,
	parseInt(values['sync-timeout'] || process.env.CLONE_SYNC_TIMEOUT, 10) || DEFAULT_SYNC_TIMEOUT_MS
);
const replicationPort: string = values['replication-port'] || process.env.REPLICATION_PORT;
const skipSSHKeys: boolean = values['skip-ssh-keys'] ?? process.env.CLONE_SKIP_SSH_KEYS === 'true';
const skipJWTKeys: boolean = values['skip-jwt-keys'] ?? process.env.CLONE_SKIP_JWT_KEYS === 'true';
const forceClone: boolean = values['force-clone'] ?? process.env.FORCE_CLONE === 'true';
const allowSelfSigned: boolean = values['allow-self-signed'] ?? process.env.ALLOW_SELF_SIGNED === 'true';
const nodeHostname: string = values['node-hostname'] || process.env.NODE_HOSTNAME || process.env.REPLICATION_HOSTNAME;
let rootPath: string = values['rootpath'] || values['ROOTPATH'] || process.env.ROOTPATH;
const cloneUsingSetNode: boolean = !!(leaderUsername && leaderPassword);
let harperLogger: any;
let leaderReplicationURL: string;
let hdbConfig: Record<string, any> = {};
let freshClone: boolean = false;

export async function cloneNode(): Promise<void> {
	// Use the set_node method to clone if both leader username and password are provided; otherwise, clone using only
	// websockets and certificate-based authorization
	log(`Starting clone node from leader: ${leaderURL} using ${cloneUsingSetNode ? 'set_node' : 'websockets'} method`);

	// If a root path was provided, use it. Otherwise, check for existing install to get root path or start a fresh clone and generate a new root path.
	resolveRootPath();

	// Make sure rootPath is set in all the places that is could be needed.
	// This is especially important for local testing where multiple Harper versions are running on the same machine.
	envMgr.setHdbBasePath(rootPath);

	leaderReplicationURL = leaderURL
		.replace('http://', 'ws://')
		.replace('https://', 'wss://')
		.replace(/:(\d+)/, `:${replicationPort || DEFAULT_REPLICATION_PORT}`);

	if (allowSelfSigned) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

	if (cloneUsingSetNode) {
		// Request to leader to verify connectivity and credentials before proceeding with clone
		// Cannot check if cloning with WS - module initialization order prevents access to required variables
		await leaderRequest({ operation: OPERATIONS_ENUM.GET_STATUS });
	}

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
	await cloneConfig();

	// Base set node request
	type SetNodeRequest = {
		operation: string;
		verify_tls: boolean;
		url: string;
		authorization?: {
			username: string;
			password: string;
		};
	};

	const setNodeRequest: SetNodeRequest = {
		operation: OPERATIONS_ENUM.ADD_NODE,
		verify_tls: !allowSelfSigned,
		url: leaderReplicationURL,
	};

	if (cloneUsingSetNode) {
		// If cloning using set_node, we need to include the leader credentials in the set node request so that the leader can authenticate this node
		setNodeRequest.authorization = {
			username: leaderUsername,
			password: leaderPassword,
		};
	} else {
		// We delete the clone-temp-admin user because now that HDB is installed we want user to come from the leader via replication
		// systemExists check will show if this is the first time clone is being run.
		if (!systemExists) {
			const { databases } = await import('../core/resources/databases.js');
			await databases.system.hdb_user.delete({ username: 'clone-temp-admin' });
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

	// Not possible to clone JWT keys using operations API
	if (!cloneUsingSetNode) {
		await cloneJWTKeys();
	}

	await cloneSSHKeys();

	// Monitor the synchronization status of the databases after cloning and update availability status once sync is complete
	await monitorSync();

	// Set a config value to indicate that this node has been cloned, which can be used by other processes to check clone status and prevent duplicate cloning
	updateConfigValue(CONFIG_PARAMS.CLONED, true);

	log(`Clone from leader node ${leaderURL} complete`);
}

/**
 * Monitors database synchronization status after cloning and updates availability status once complete.
 * Polls at regular intervals until sync completes or timeout is reached.
 */
async function monitorSync(): Promise<void> {
	if (skipSyncMonitor) return;
	const { clusterStatus } = await import('../replication/clusterStatus.js');
	const { set: setStatus } = await import('../core/server/status/index.js');

	// Get last updated record timestamps for all DB and write to file
	// These values can be used for checking when the clone replication has caught up with the leader
	const targetTimestamps = await getLastUpdatedRecord();
	if (!targetTimestamps || Object.keys(targetTimestamps).length === 0) {
		log('No target timestamps available to check synchronization status', 'error');
		return;
	}

	log(
		`Starting to monitor sync status. Will check every ${DEFAULT_SYNC_CHECK_INTERVAL_MS}ms for up to ${Math.round(syncTimeoutMs / 60000)} minutes`
	);

	const timeoutAt: number = Date.now() + syncTimeoutMs;
	let syncComplete: boolean = false;
	let loopCount: number = 0;

	while (!syncComplete && Date.now() < timeoutAt) {
		try {
			syncComplete = await checkSyncStatus(targetTimestamps, clusterStatus);

			if (syncComplete) {
				log('All databases synchronized');

				try {
					await setStatus({ id: 'availability', status: 'Available' });
				} catch (err) {
					// Don't fail sync monitoring due to status update failure
					log(`Failed to update availability status: ${err}`, 'error');
				}

				break; // Exit loop on successful sync
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
		const keys: Record<string, any> = await leaderRequest({ operation: 'list_ssh_keys' });
		if (!keys?.length) {
			log('No SSH keys found on leader node to clone');
			return;
		}

		for (const keyName of keys) {
			log('Cloning SSH key:', keyName.name);
			const keyData: Record<string, any> = await leaderRequest({
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

	try {
		log('Cloning JWT keys');
		const keysDir = join(rootPath, LICENSE_KEY_DIR_NAME);

		const jwtPublic: Record<string, any> = await leaderRequest({
			operation: 'get_key',
			name: '.jwtPublic',
		});
		writeFileSync(join(keysDir, JWT_ENUM.JWT_PUBLIC_KEY_NAME), jwtPublic.message);

		const jwtPrivate: Record<string, any> = await leaderRequest({
			operation: 'get_key',
			name: '.jwtPrivate',
		});
		writeFileSync(join(keysDir, JWT_ENUM.JWT_PRIVATE_KEY_NAME), jwtPrivate.message);

		const jwtPass: Record<string, any> = await leaderRequest({
			operation: 'get_key',
			name: '.jwtPass',
		});
		writeFileSync(join(keysDir, JWT_ENUM.JWT_PASSPHRASE_NAME), jwtPass.message);
	} catch (err) {
		log(`Error cloning JWT keys: ${err}`, 'error');
	}
}

async function cloneConfig(): Promise<void> {
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
}

/**
 * Send a request to the leader node for the given operation, using either WebSockets or HTTP based on the useWS flag
 * @param operation
 */
async function leaderRequest(operation: { operation: string; [key: string]: any }): Promise<Record<string, any>> {
	if (!cloneUsingSetNode) {
		// Dynamically importing the replicator module because it was causing early import of rootpath var on
		// install before it was initialized.
		const { sendOperationToNode } = await import('../replication/replicator.js');
		return sendOperationToNode({ url: leaderReplicationURL }, operation, {
			rejectUnauthorized: !allowSelfSigned,
		});
	}

	const isHttps = leaderURL.startsWith('https://');

	const fetchOptions: RequestInit = {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Basic ${Buffer.from(`${leaderUsername}:${leaderPassword}`).toString('base64')}`,
		},
		body: JSON.stringify(operation),
	};

	// Only add agent for HTTPS
	if (isHttps) {
		// @ts-ignore - agent option exists but TypeScript definitions may not include it
		fetchOptions.agent = new https.Agent({
			rejectUnauthorized: !allowSelfSigned,
		});
	}

	const response = await fetch(leaderURL, fetchOptions);
	if (!response.ok) {
		throw new Error(`Leader request failed: ${response.status} ${response.statusText}`);
	}

	return response.json();
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

	if (!cloneUsingSetNode) {
		// Set temporary admin credentials if cloning without set_node to allow installation to complete.
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
