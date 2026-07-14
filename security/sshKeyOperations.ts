import Joi from 'joi';
import { join, dirname, basename } from 'node:path';
import { constants, access, readFile, writeFile, unlink, chmod, appendFile, mkdir, readdir } from 'node:fs/promises';

import { validateBySchema } from '../core/validation/validationWrapper.js';
import harperLogger from '../core/utility/logging/harper_logger.js';
import { ClientError } from '../core/utility/errors/hdbError.js';
import { CONFIG_PARAMS } from '../core/utility/hdbTerms.ts';
import * as env from '../core/utility/environment/environmentManager.js';
import { getSecretCustody } from '../core/resources/secretDecryptor.ts';
import { encryptEnvelope, parseEnvelopeFields } from '../core/utility/secretEnvelope.ts';
import { ENV_ENCRYPTED_PREFIX } from '../core/utility/envFile.ts';
import { replicateOperation } from '../replication/replicator.ts';

// SSH key name can only be alphanumeric, dash and underscores
const SSH_KEY_NAME_REGEX = /^[a-zA-Z0-9-_]+$/;
const SSH_KEY_NAME_ERROR_MSG = 'SSH key name can only contain alphanumeric, dash and underscore characters';

// Helper function to check if a file or directory exists
const exists = async (path: string): Promise<boolean> =>
	access(path, constants.F_OK)
		.then(() => true)
		.catch(() => false);

// Helper function to write a file ensuring the directory exists
async function writeFileEnsureDir(filePath: string, data: string, mode?: number) {
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, data, mode === undefined ? undefined : { mode });
}

/**
 * Seal a private key for storage and replication. The `enc:v1:` envelope is what lands on disk and
 * what goes into the replicated operation body, so the plaintext key reaches neither a peer's disk
 * nor the wire.
 *
 * A key that arrives already sealed — replicated from a peer, or fetched from the leader by
 * `cloneSSHKeys` — is stored verbatim and never decrypted here, so forwarding a key never requires
 * holding its plaintext. Its `kid` is checked against this node's custody exactly the way
 * `set_secret` vets an ingested envelope.
 *
 * Degraded mode: with no custody registered there is no key to seal against, so the key is stored
 * as plaintext — today's behavior — and a WARN says so plainly. This follows the precedent set by
 * core's `ingestRegistryAuth`, which likewise passes a literal credential through rather than
 * failing the operation when custody is absent: SSH keys predate custody and must keep working on
 * a node that has none. Custody is present by default (the file tier generates a cluster keypair on
 * first boot), so this is the exception rather than the path.
 */
function sealSSHKey(name: string, key: string): string {
	const custody = getSecretCustody();

	if (key.startsWith(ENV_ENCRYPTED_PREFIX)) {
		let kid: string | undefined;
		try {
			kid = parseEnvelopeFields(key.slice(ENV_ENCRYPTED_PREFIX.length)).kid;
		} catch (error) {
			throw new ClientError(`Invalid SSH key envelope: ${(error as Error).message}`);
		}
		const fingerprint = custody?.getPublicKey().fingerprint;
		if (fingerprint && kid && kid !== fingerprint) {
			throw new ClientError(
				`SSH key envelope kid '${kid}' does not match this cluster's secrets key (expected '${fingerprint}')`
			);
		}
		return key;
	}

	if (!custody) {
		harperLogger?.warn(
			`SSH key '${name}' is being stored and replicated in PLAINTEXT: no secret custody is registered on this node. ` +
				'Configure secret custody (`secretCustody` in the Harper config) so deploy keys are encrypted at rest.'
		);
		return key;
	}

	const { publicKey, fingerprint } = custody.getPublicKey();
	return ENV_ENCRYPTED_PREFIX + encryptEnvelope(key, publicKey, fingerprint);
}

const addValidationSchema = Joi.object({
	name: Joi.string().pattern(SSH_KEY_NAME_REGEX).required().messages({ 'string.pattern.base': SSH_KEY_NAME_ERROR_MSG }),
	key: Joi.string().required(),
	host: Joi.string().required(),
	hostname: Joi.string().required(),
	known_hosts: Joi.string().optional(),
});

const getSSHKeyValidationSchema = Joi.object({
	name: Joi.string().required(),
});

const updateSSHKeyValidationSchema = Joi.object({
	name: Joi.string().required(),
	key: Joi.string().required(),
});

const deleteSSHKeyValidationSchema = Joi.object({
	name: Joi.string().required(),
});

const setSSHKnownHostsValidationSchema = Joi.object({
	known_hosts: Joi.string().required(),
});

function getSSHPaths(keyName: string | undefined): {
	sshDir: string;
	filePath: string | undefined;
	configFile: string;
	knownHostsFile: string;
} {
	const rootDir = env.get(CONFIG_PARAMS.ROOTPATH);
	const sshDir = join(rootDir, 'ssh');
	const filePath = keyName ? join(sshDir, keyName + '.key') : undefined;
	const configFile = join(sshDir, 'config');
	const knownHostsFile = join(sshDir, 'known_hosts');

	return { sshDir, filePath, configFile, knownHostsFile };
}

interface AddSSHKeyRequest {
	name: string;
	key: string;
	host: string;
	hostname: string;
	known_hosts?: string;
}

/**
 * Adds a new SSH key along with its associated SSH config block and optional
 * known_hosts entries. If the hostname is `github.com`, GitHub's public SSH
 * keys are automatically fetched and added to the known_hosts file.
 *
 * The private key is sealed (`sealSSHKey`) before it reaches disk or the replicated operation
 * body; core decrypts it to a transient file only for the lifetime of a git invocation
 * (`materializeGitSSH`).
 *
 * @param req - The request object containing the SSH key details.
 * @param req.name - The name of the SSH key to add.
 * @param req.key - The SSH key contents, either plaintext or an `enc:v1:` envelope.
 * @param req.host - The Host alias to use in the SSH config block.
 * @param req.hostname - The HostName (real hostname) to use in the SSH config block.
 * @param req.known_hosts - Optional known_hosts entries to append to the known_hosts file.
 * @returns An object containing a success message and optional replication results.
 */
export async function addSSHKey(req: AddSSHKeyRequest): Promise<{ message: string; replicated?: unknown[] }> {
	const validation = validateBySchema(req, addValidationSchema);
	if (validation) throw new ClientError(validation.message);

	const { name, key, host, hostname, known_hosts } = req;
	harperLogger?.trace('adding ssh key', name);

	const { filePath, configFile, knownHostsFile } = getSSHPaths(name);

	// Check if the key already exists
	if (await exists(filePath)) {
		throw new ClientError('Key already exists. Use update_ssh_key or delete_ssh_key and then add_ssh_key');
	}

	// Seal before anything durable or replicated happens, and replicate the envelope rather than
	// the plaintext the caller supplied.
	const storedKey = sealSSHKey(name, key);
	req.key = storedKey;

	// Create the key file
	await writeFileEnsureDir(filePath, storedKey, 0o600);
	await chmod(filePath, 0o600);

	// Build the config block string
	const configBlock = `#${name}
Host ${host}
	HostName ${hostname}
	User git
	IdentityFile ${filePath}
	IdentitiesOnly yes`;

	// If the file already exists, add a new config block, otherwise write the file for the first time
	if (await exists(configFile)) {
		await appendFile(configFile, '\n' + configBlock);
	} else {
		await writeFileEnsureDir(configFile, configBlock);
	}

	let additionalMessage = '';

	// Create the known_hosts file and set permissions if missing
	if (!(await exists(knownHostsFile))) {
		await writeFileEnsureDir(knownHostsFile, '');
		await chmod(knownHostsFile, 0o600);
	}

	// If adding a github.com ssh key download it automatically
	if (hostname === 'github.com') {
		const fileContents: string = await readFile(knownHostsFile, 'utf8');

		// Check if there's already github.com entries
		if (!fileContents.includes('github.com')) {
			try {
				const response = await fetch('https://api.github.com/meta');
				const respJson = await response.json();
				const sshKeys = respJson['ssh_keys'];
				for (const knownHost of sshKeys) {
					await appendFile(knownHostsFile, 'github.com ' + knownHost + '\n');
				}
			} catch {
				additionalMessage =
					'. Unable to get known hosts from github.com. Set your known hosts manually using set_ssh_known_hosts.';
			}
		}
	}

	if (known_hosts) {
		await appendFile(knownHostsFile, known_hosts);
	}
	let response = await replicateOperation(req);
	response.message = `Added ssh key: ${name}${additionalMessage}`;

	return response;
}

/**
 * Retrieves an SSH key by name, along with any associated Host and HostName
 * configuration from the SSH config file.
 *
 * `key` is returned exactly as stored — an `enc:v1:` envelope on a node with secret custody, or
 * plaintext on one without (see `sealSSHKey`). It is deliberately NOT decrypted: the only consumer
 * is `cloneSSHKeys`, which feeds it straight back into `add_ssh_key` on the cloning node, and
 * returning the envelope keeps the private key off the clone's wire as well as off its disk.
 *
 * @param req - The request object containing the key name.
 * @param req.name - The name of the SSH key to retrieve.
 * @returns An object containing the key name, the stored key (sealed envelope or plaintext), and
 * optionally the Host and HostName from the SSH config file.
 */
export async function getSSHKey(req: {
	name: string;
}): Promise<{ name: string; key: string; host?: string; hostname?: string }> {
	const validation = validateBySchema(req, getSSHKeyValidationSchema);
	if (validation) throw new ClientError(validation.message);

	const { name } = req;
	const { filePath, configFile } = getSSHPaths(name);

	if (!(await exists(filePath))) {
		throw new ClientError(`SSH key '${name}' does not exist.`);
	}

	harperLogger?.trace(`getting ssh key`, name, filePath);

	const key = await readFile(filePath, 'utf8');
	const result: { name: string; key: string; host?: string; hostname?: string } = { name, key };

	if (await exists(configFile)) {
		const configContents = await readFile(configFile, 'utf8');
		const { host, hostname } = extractMatchingHostAndHostname(configContents, name);
		if (host) result.host = host;
		if (hostname) result.hostname = hostname;
	}

	return result;
}

/**
 * Updates an existing SSH key by overwriting the key file with new contents. Rotation semantics are
 * unchanged; only the stored representation is sealed (see `sealSSHKey`).
 *
 * @param req - The request object containing the updated key details.
 * @param req.name - The name of the SSH key to update.
 * @param req.key - The new SSH key contents, either plaintext or an `enc:v1:` envelope.
 * @returns An object containing a success message and optional replication results.
 */
export async function updateSSHKey(req: {
	name: string;
	key: string;
}): Promise<{ message: string; replicated?: unknown[] }> {
	const validation = validateBySchema(req, updateSSHKeyValidationSchema);
	if (validation) throw new ClientError(validation.message);

	const { name, key } = req;
	harperLogger?.trace(`updating ssh key`, name);

	const { filePath } = getSSHPaths(name);
	if (!(await exists(filePath))) {
		throw new ClientError(`SSH key '${name}' does not exist. Use add_ssh_key to create it.`);
	}

	const storedKey = sealSSHKey(name, key);
	req.key = storedKey;

	await writeFileEnsureDir(filePath, storedKey, 0o600);
	await chmod(filePath, 0o600);

	const response = await replicateOperation(req);
	response.message = `Updated ssh key: ${name}`;
	return response;
}

/**
 * Deletes an existing SSH key and removes its associated config block from
 * the SSH config file.
 *
 * @param req - The request object containing the key name.
 * @param req.name - The name of the SSH key to delete.
 * @returns An object containing a success message and optional replication results.
 */
async function deleteSSHKey(req: { name: string }): Promise<{ message: string; replicated?: unknown[] }> {
	const validation = validateBySchema(req, deleteSSHKeyValidationSchema);
	if (validation) throw new ClientError(validation.message);

	const { name } = req;
	harperLogger?.trace(`deleting ssh key`, name);

	const { filePath, configFile } = getSSHPaths(name);
	if (!(await exists(filePath))) {
		throw new ClientError(`SSH key '${name}' does not exist.`);
	}

	if (await exists(configFile)) {
		const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const configBlockRegex = new RegExp(`#${escapedName}[\\S\\s]*?IdentitiesOnly yes`, 'g');
		const fileContents = (await readFile(configFile, 'utf8')).replace(configBlockRegex, '').trim();
		await writeFileEnsureDir(configFile, fileContents);
	}

	await unlink(filePath);

	const response = await replicateOperation(req);
	response.message = `Deleted ssh key: ${name}`;
	return response;
}

/**
 * Lists all SSH keys along with their associated Host and HostName
 * configuration from the SSH config file.
 *
 * @returns An array of objects containing the key name and optionally
 * the Host and HostName from the SSH config file.
 */
export async function listSSHKeys(): Promise<{ name: string; host?: string; hostname?: string }[]> {
	const { sshDir, configFile } = getSSHPaths(undefined);
	if (!(await exists(sshDir))) return [];

	const EXCLUDED_FILES = new Set(['known_hosts', 'config']);
	const configContents: string | null = (await exists(configFile)) ? await readFile(configFile, 'utf8') : null;
	const files: string[] = await readdir(sshDir);
	return files
		.filter((file) => !EXCLUDED_FILES.has(file))
		.map((file) => {
			const name: string = basename(file, '.key');
			const result: { name: string; host?: string; hostname?: string } = { name };

			if (configContents) {
				const { host, hostname } = extractMatchingHostAndHostname(configContents, name);
				if (host) result.host = host;
				if (hostname) result.hostname = hostname;
			}

			return result;
		});
}

/**
 * Extracts the Host and HostName values from an SSH config block matching
 * the given key name. Config blocks are identified by a leading comment
 * in the format `#keyName`.
 *
 * @param configContents - The full contents of the SSH config file.
 * @param name - The name of the SSH key whose config block to extract from.
 * @returns An object containing the optional Host and HostName values from
 * the matching config block, or an empty object if no match is found.
 */
function extractMatchingHostAndHostname(configContents: string, name: string): { host?: string; hostname?: string } {
	const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const configBlockRegex = new RegExp(`#${escapedName}[\\S\\s]*?IdentitiesOnly yes`, 'g');
	const match = configContents.match(configBlockRegex);

	if (!match?.[0]) return {};

	const configBlock = match[0];

	const host = configBlock.match(/^Host\s+(.+)$/m)?.[1]?.trim();
	const hostname = configBlock.match(/^\s*HostName\s+(.+)$/m)?.[1]?.trim();

	return {
		...(host && { host }),
		...(hostname && { hostname }),
	};
}

/**
 * Overwrites the SSH known_hosts file with the provided entries.
 *
 * @param req - The request object containing the known_hosts entries.
 * @param req.known_hosts - The known_hosts entries to write to the file.
 * @returns An object containing a success message and optional replication results.
 */
async function setSSHKnownHosts(req: { known_hosts: string }): Promise<{ message: string; replicated?: unknown[] }> {
	const validation = validateBySchema(req, setSSHKnownHostsValidationSchema);
	if (validation) throw new ClientError(validation.message);

	const { known_hosts } = req;
	harperLogger?.trace(`setting ssh known hosts`);

	const { knownHostsFile } = getSSHPaths(undefined);
	await writeFileEnsureDir(knownHostsFile, known_hosts);
	await chmod(knownHostsFile, 0o600);

	const response = await replicateOperation(req);
	response.message = `Known hosts successfully set`;

	return response;
}

/**
 * Retrieves the contents of the SSH known_hosts file.
 *
 * @returns An object containing the known_hosts file contents,
 * or `null` if the file does not exist.
 */
async function getSSHKnownHosts(): Promise<{ known_hosts: string | null }> {
	harperLogger?.trace(`getting ssh known hosts`);
	const { knownHostsFile } = getSSHPaths(undefined);
	if (!(await exists(knownHostsFile))) {
		return { known_hosts: null };
	}

	return { known_hosts: await readFile(knownHostsFile, 'utf8') };
}

// These will register the operations for the operations API. For now the method and schema are ignored,
// they are there for when build the REST interface for operations API
server.registerOperation?.({
	name: 'add_ssh_key',
	execute: addSSHKey,
	httpMethod: 'PUT',
	parametersSchema: [{ name: 'hostname', in: 'path', schema: { type: 'string' } }],
});

server.registerOperation?.({
	name: 'get_ssh_key',
	execute: getSSHKey,
	httpMethod: 'GET',
	parametersSchema: [{ name: 'hostname', in: 'path', schema: { type: 'string' } }],
});

server.registerOperation?.({
	name: 'update_ssh_key',
	execute: updateSSHKey,
	httpMethod: 'PATCH',
	parametersSchema: [{ name: 'hostname', in: 'path', schema: { type: 'string' } }],
});

server.registerOperation?.({
	name: 'delete_ssh_key',
	execute: deleteSSHKey,
	httpMethod: 'DELETE',
	parametersSchema: [{ name: 'hostname', in: 'path', schema: { type: 'string' } }],
});

server.registerOperation?.({
	name: 'list_ssh_keys',
	execute: listSSHKeys,
	httpMethod: 'GET',
	parametersSchema: [{ name: 'hostname', in: 'path', schema: { type: 'string' } }],
});

server.registerOperation?.({
	name: 'set_ssh_known_hosts',
	execute: setSSHKnownHosts,
	httpMethod: 'PUT',
	parametersSchema: [{ name: 'hostname', in: 'path', schema: { type: 'string' } }],
});

server.registerOperation?.({
	name: 'get_ssh_known_hosts',
	execute: getSSHKnownHosts,
	httpMethod: 'GET',
	parametersSchema: [{ name: 'hostname', in: 'path', schema: { type: 'string' } }],
});
