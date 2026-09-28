import Joi from 'joi';
import { randomUUID } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import {
	constants,
	access,
	readFile,
	writeFile,
	unlink,
	chmod,
	appendFile,
	mkdir,
	readdir,
	stat,
	open,
	realpath,
	rename,
	type FileHandle,
} from 'node:fs/promises';

import { validateBySchema } from '../core/validation/validationWrapper.js';
import { isUnsupportedSyncError } from '../core/utility/fsync.ts';
import harperLogger from '../core/utility/logging/harper_logger.js';
import { ClientError } from '../core/utility/errors/hdbError.js';
import { CONFIG_PARAMS } from '../core/utility/hdbTerms.ts';
import * as env from '../core/utility/environment/environmentManager.js';
import { getSecretCustody } from '../core/resources/secretDecryptor.ts';
import { encryptEnvelope, parseEnvelopeFields } from '../core/utility/secretEnvelope.ts';
import { ENV_ENCRYPTED_PREFIX } from '../core/utility/envFile.ts';
import { replicateOperation } from '../replication/replicator.ts';
import { generateEd25519SSHKeyPair } from './sshKeyGeneration.ts';
import {
	describeSSHConfigValueProblem,
	describeSSHPrivateKeyProblem,
	normalizeSSHPrivateKey,
} from './sshKeyValidation.ts';

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
		const fingerprint = custody?.getPublicKey()?.fingerprint;
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

/**
 * An `enc:v1:` envelope passes through for `sealSSHKey` to vet: it can't be inspected without
 * decrypting it, which forwarding a key must never require.
 */
function vetSSHPrivateKey(key: string): string {
	if (key.startsWith(ENV_ENCRYPTED_PREFIX)) return key;
	const problem = describeSSHPrivateKeyProblem(key);
	if (problem) throw new ClientError(problem);
	return normalizeSSHPrivateKey(key);
}

function vetSSHConfigValue(field: 'host' | 'hostname', value: string): string {
	const trimmed = value.trim();
	const problem = describeSSHConfigValueProblem(field, trimmed);
	if (problem) throw new ClientError(problem);
	return trimmed;
}

// The name is a path segment (`<ssh dir>/<name>.key`): accept only what add_ssh_key can create, or `../x`
// escapes the ssh dir.
const sshKeyNameSchema = Joi.string()
	.pattern(SSH_KEY_NAME_REGEX)
	.required()
	.messages({ 'string.pattern.base': SSH_KEY_NAME_ERROR_MSG });

const addValidationSchema = Joi.object({
	name: sshKeyNameSchema,
	// `key` is optional so it can be omitted with `generate: true` (the server mints it); the
	// "key xor generate" invariant is enforced in addSSHKey for a precise error. `.strict()` because
	// Joi would otherwise accept the strings 'true'/'false' by coercion, and `validateBySchema`
	// discards the coerced value — leaving the raw, always-truthy string on the request.
	generate: Joi.boolean().strict().optional(),
	key: Joi.string().optional(),
	host: Joi.string().required(),
	hostname: Joi.string().required(),
	known_hosts: Joi.string().optional(),
});

const getSSHKeyValidationSchema = Joi.object({
	name: sshKeyNameSchema,
});

const updateSSHKeyValidationSchema = Joi.object({
	name: sshKeyNameSchema,
	key: Joi.string().required(),
});

const deleteSSHKeyValidationSchema = Joi.object({
	name: sshKeyNameSchema,
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
	key?: string; // optional when `generate` is true (the server mints the keypair)
	generate?: boolean;
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
 * @param req.key - The SSH key contents, either plaintext or an `enc:v1:` envelope. Mutually
 * exclusive with `generate`; exactly one of the two is required. A plaintext key is stored
 * normalized, and refused when ssh couldn't load it.
 * @param req.generate - Mint an ed25519 keypair on this node instead of supplying `key`, so the
 * private half never travels from the client. The public half comes back as `public_key`.
 * @param req.host - The Host alias to use in the SSH config block; trimmed, and refused when it would
 * break the node's ssh config.
 * @param req.hostname - The HostName (real hostname) to use in the SSH config block; vetted like `host`.
 * @param req.known_hosts - Optional known_hosts entries to append to the known_hosts file.
 * @returns An object containing a success message, optional replication results, and `public_key`
 * when the keypair was generated.
 */
export async function addSSHKey(
	req: AddSSHKeyRequest
): Promise<{ message: string; replicated?: unknown[]; public_key?: string }> {
	const validation = validateBySchema(req, addValidationSchema);
	if (validation) throw new ClientError(validation.message);

	// Read `generate` as a strict boolean rather than for truthiness. `validateBySchema` discards
	// Joi's coerced value, so a caller that stringifies booleans reaches here with `req.generate`
	// still the string it sent — and `'false'` is truthy, which would mint a keypair the caller
	// explicitly declined. The schema's `.strict()` rejects those strings; this comparison means the
	// branch below cannot be reached by anything but a literal `true` even if that changes.
	const generate = req.generate === true;

	// `generate` and `key` are mutually exclusive: reject both up front. (The origin strips `generate`
	// before replicating — below — so a peer never receives it and this guard never trips on the
	// replicated op.)
	if (generate && req.key) {
		throw new ClientError('Provide either `key` or `generate: true`, not both.');
	}

	req.host = vetSSHConfigValue('host', req.host);
	req.hostname = vetSSHConfigValue('hostname', req.hostname);
	if (req.key !== undefined) req.key = vetSSHPrivateKey(req.key);

	// Reject a duplicate name BEFORE minting anything: with `generate: true` a taken name means the add
	// is already doomed, so there is no reason to mint private-key material for a request guaranteed to
	// throw below.
	const { filePath, configFile, knownHostsFile } = getSSHPaths(req.name);
	if (await exists(filePath)) {
		throw new ClientError('Key already exists. Use update_ssh_key or delete_ssh_key and then add_ssh_key');
	}

	// With `generate: true`, mint the keypair here so the private key never leaves the cluster; the
	// public half is returned for the caller to register (e.g. a GitHub deploy key). The minted key
	// then flows through the same seal-at-rest + replicate path (sealSSHKey) as a supplied one, so
	// where custody is registered the plaintext stays in this process. On a node with NO custody it
	// does not: `sealSSHKey` passes the key through and it is replicated in the clear, same as a
	// supplied key in that mode (see the WARN there).
	let publicKey: string | undefined;
	if (generate) {
		const generated = await generateEd25519SSHKeyPair(`harper:${req.name}`);
		req.key = generated.privateKey;
		publicKey = generated.publicKey;
	}
	// Unconditionally, so no variant of the flag — including a literal `false` — reaches a peer, which
	// must store the key it is sent rather than minting a different one of its own.
	delete req.generate;

	const { name, key, host, hostname, known_hosts } = req;
	if (!key) throw new ClientError('add_ssh_key requires `key`, or `generate: true` to mint one');
	harperLogger?.trace('adding ssh key', name);

	// Seal before anything durable or replicated happens, and replicate the envelope rather than
	// the plaintext the caller supplied.
	const storedKey = sealSSHKey(name, key);
	req.key = storedKey;

	// Create the key file
	await writeFileEnsureDir(filePath, storedKey, 0o600);
	await chmod(filePath, 0o600);

	// Build the config block string
	const configBlock = `#${name}
${SSH_CONFIG_BEGIN}${name}
Host ${host}
	HostName ${hostname}
	User git
	IdentityFile ${filePath}
	IdentitiesOnly yes
${SSH_CONFIG_END}${name}`;

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
	const response = await replicateOperation(req);
	response.message = `Added ssh key: ${name}${additionalMessage}`;
	// `replicateOperation` returns `{ message, replicated? }`; attach `public_key` via Object.assign so
	// the extra field doesn't trip the compiler on that narrower return type.
	if (publicKey) Object.assign(response, { public_key: publicKey });

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
	const { sshDir, filePath, configFile } = getSSHPaths(name);

	if (!(await exists(filePath))) {
		throw new ClientError(`SSH key '${name}' does not exist.`);
	}

	harperLogger?.trace(`getting ssh key`, name, filePath);

	const key = await readFile(filePath, 'utf8');
	const config = await readSSHConfigFile(configFile);
	return { name, key, ...(config !== undefined && configuredHost(readSSHConfig(config, sshDir), name)) };
}

/**
 * Updates an existing SSH key by overwriting the key file with new contents. Rotation semantics are
 * unchanged; only the stored representation is sealed (see `sealSSHKey`).
 *
 * @param req - The request object containing the updated key details.
 * @param req.name - The name of the SSH key to update.
 * @param req.key - The new SSH key contents, either plaintext or an `enc:v1:` envelope; vetted like
 * `add_ssh_key`'s, so a key ssh couldn't load never replaces a working one.
 * @returns An object containing a success message and optional replication results.
 */
export async function updateSSHKey(req: {
	name: string;
	key: string;
}): Promise<{ message: string; replicated?: unknown[] }> {
	const validation = validateBySchema(req, updateSSHKeyValidationSchema);
	if (validation) throw new ClientError(validation.message);

	req.key = vetSSHPrivateKey(req.key);
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
 * Deletes an existing SSH key and removes its associated config blocks from
 * the SSH config file, leaving every line outside them as it was.
 *
 * Refused, changing nothing, when the key's block has a BEGIN line with no END line, since where the
 * block ends is then unknown. The config is rewritten before the key file is unlinked, so a rewrite
 * that fails leaves the key usable.
 *
 * @param req - The request object containing the key name.
 * @param req.name - The name of the SSH key to delete.
 * @returns An object containing a success message and optional replication results.
 */
export async function deleteSSHKey(req: { name: string }): Promise<{ message: string; replicated?: unknown[] }> {
	const validation = validateBySchema(req, deleteSSHKeyValidationSchema);
	if (validation) throw new ClientError(validation.message);

	const { name } = req;
	harperLogger?.trace(`deleting ssh key`, name);

	const { sshDir, filePath, configFile } = getSSHPaths(name);
	if (!(await exists(filePath))) {
		throw new ClientError(`SSH key '${name}' does not exist.`);
	}

	const config = await readSSHConfigFile(configFile);
	if (config !== undefined) {
		const view = readSSHConfig(config, sshDir);
		const unterminatedLine = view.unterminated.get(name);
		if (unterminatedLine !== undefined) {
			throw new ClientError(
				`SSH key '${name}' was not deleted: line ${unterminatedLine} of the SSH config begins its block ` +
					`("${SSH_CONFIG_BEGIN}${name}"), but no "${SSH_CONFIG_END}${name}" line ends it. ` +
					'Restore that line, or remove the block by hand, then delete the key again.'
			);
		}
		const updated = renderSSHConfig(view, name);
		if (updated !== config) await writeSSHConfig(configFile, updated);
	}

	await unlink(filePath);

	const response = await replicateOperation(req);
	response.message = `Deleted ssh key: ${name}`;
	return response;
}

/**
 * Lists the SSH keys the other key operations can act on — each `<name>.key` file in the ssh dir, or
 * symlink to one, whose name passes `SSH_KEY_NAME_REGEX` — along with their associated Host and
 * HostName configuration from the SSH config file.
 *
 * @returns An array of objects containing the key name and optionally
 * the Host and HostName from the SSH config file.
 */
export async function listSSHKeys(): Promise<{ name: string; host?: string; hostname?: string }[]> {
	const { sshDir, configFile } = getSSHPaths(undefined);
	if (!(await exists(sshDir))) return [];

	const config = await readSSHConfigFile(configFile);
	const view = config === undefined ? undefined : readSSHConfig(config, sshDir);
	const results: { name: string; host?: string; hostname?: string }[] = [];
	for (const name of await listSSHKeyNames(sshDir)) {
		results.push({ name, ...(view && configuredHost(view, name)) });
	}
	return results;
}

async function listSSHKeyNames(sshDir: string): Promise<string[]> {
	const names: string[] = [];
	for (const file of await readdir(sshDir)) {
		const name = basename(file, '.key');
		if (!file.endsWith('.key') || !SSH_KEY_NAME_REGEX.test(name)) continue;
		// like get_ssh_key's readFile, stat follows a symlink to its key file
		if ((await stat(join(sshDir, file)).catch(() => undefined))?.isFile()) names.push(name);
	}
	return names;
}

const SSH_CONFIG_BEGIN = '# BEGIN harper ssh key ';
const SSH_CONFIG_END = '# END harper ssh key ';
const SSH_CONFIG_MARKER = /^[ \t]*# (BEGIN|END) harper ssh key ([a-zA-Z0-9-_]+)[ \t]*$/;
const SSH_CONFIG_KEY_COMMENT = /^[ \t]*#([a-zA-Z0-9-_]+)[ \t]*$/;
const SSH_CONFIG_SECTION_START = /^[ \t]*(?:Host|Match)(?:[ \t]*=|[ \t]+)/i;
const SSH_CONFIG_BLANK_OR_COMMENT = /^[ \t]*(?:#.*)?$/;
const SSH_CONFIG_IDENTITY_FILE = /^[ \t]*IdentityFile(?:[ \t]*=[ \t]*|[ \t]+)(.*?)[ \t]*$/i;

interface SSHConfigLine {
	start: number;
	// past the line break, when the line has one
	end: number;
	text: string;
}

interface SSHConfigBlock {
	first: number;
	last: number;
	// written before blocks had markers: `first` is its `#name` line, `last` its last directive
	legacy: boolean;
}

interface SSHConfigView {
	config: string;
	lines: SSHConfigLine[];
	blocks: Map<string, SSHConfigBlock[]>;
	// the 1-based line of the name's first BEGIN that no END closes
	unterminated: Map<string, number>;
}

/**
 * The key blocks in an SSH config. A block runs from `# BEGIN harper ssh key <name>` to the next
 * `# END harper ssh key <name>` with no other marker between, plus the `#<name>` line directly above
 * its BEGIN, kept so that a version that finds blocks by their `#<name>` line alone still reads and
 * deletes exactly the block. A BEGIN that meets another marker or the end of the file first leaves the
 * block's end unknown; a stray END delimits nothing.
 *
 * A block written before blocks had markers is read as if it had them: a `#<name>` line and the section
 * it heads, bounded the way OpenSSH scopes it, trailing comments excluded — but only when one of its
 * `IdentityFile` lines is exactly the key file `addSSHKey` writes for that name, since nothing else in
 * that format shows who wrote the section.
 */
function readSSHConfig(config: string, sshDir: string): SSHConfigView {
	const lines: SSHConfigLine[] = [];
	for (let start = 0; start < config.length;) {
		const newline = config.indexOf('\n', start);
		const end = newline === -1 ? config.length : newline + 1;
		lines.push({ start, end, text: config.slice(start, newline === -1 ? end : newline).replace(/\r$/, '') });
		start = end;
	}

	const blocks = new Map<string, SSHConfigBlock[]>();
	const addBlock = (name: string, block: SSHConfigBlock) => {
		const named = blocks.get(name);
		if (named) named.push(block);
		else blocks.set(name, [block]);
	};
	const unterminated = new Map<string, number>();
	const marked = new Uint8Array(lines.length);
	let open: { name: string; index: number } | undefined;
	const abandonOpen = () => {
		if (open && !unterminated.has(open.name)) unterminated.set(open.name, open.index + 1);
		open = undefined;
	};
	for (let index = 0; index < lines.length; index++) {
		const marker = SSH_CONFIG_MARKER.exec(lines[index].text);
		if (!marker) continue;
		marked[index] = 1;
		const [, kind, name] = marker;
		if (kind === 'BEGIN') {
			abandonOpen();
			open = { name, index };
		} else if (open?.name === name) {
			const headed = open.index > 0 && SSH_CONFIG_KEY_COMMENT.exec(lines[open.index - 1].text)?.[1] === name;
			const first = headed ? open.index - 1 : open.index;
			marked.fill(1, first, index + 1);
			addBlock(name, { first, last: index, legacy: false });
			open = undefined;
		} else abandonOpen();
	}
	abandonOpen();

	for (let from = 0; from < lines.length; from++) {
		let to = from;
		while (to < lines.length && !marked[to]) to++;
		if (to > from) findLegacySSHConfigBlocks(lines, from, to, sshDir, addBlock);
		from = to;
	}
	for (const named of blocks.values()) named.sort((a, b) => a.first - b.first);
	return { config, lines, blocks, unterminated };
}

function findLegacySSHConfigBlocks(
	lines: SSHConfigLine[],
	from: number,
	to: number,
	sshDir: string,
	addBlock: (name: string, block: SSHConfigBlock) => void
): void {
	const startsSection = (index: number) => SSH_CONFIG_SECTION_START.test(lines[index].text);
	const sectionHeadedBy = (index: number): number | undefined => {
		for (let next = index + 1; next < to; next++) {
			const { text } = lines[next];
			if (SSH_CONFIG_KEY_COMMENT.test(text)) return undefined;
			if (!SSH_CONFIG_BLANK_OR_COMMENT.test(text)) return startsSection(next) ? next : undefined;
		}
		return undefined;
	};
	const isKeyHeader = (index: number) =>
		SSH_CONFIG_KEY_COMMENT.test(lines[index].text) && sectionHeadedBy(index) !== undefined;

	for (let index = from; index < to; index++) {
		const name = SSH_CONFIG_KEY_COMMENT.exec(lines[index].text)?.[1];
		if (!name) continue;
		let end = (sectionHeadedBy(index) ?? index) + 1;
		while (end < to && !startsSection(end) && !isKeyHeader(end)) end++;
		let last = end - 1;
		while (last > index && SSH_CONFIG_BLANK_OR_COMMENT.test(lines[last].text)) last--;
		if (!namesKeyFile(lines, index + 1, last, join(sshDir, name + '.key'))) continue;
		addBlock(name, { first: index, last, legacy: true });
		index = last;
	}
}

function namesKeyFile(lines: SSHConfigLine[], from: number, to: number, keyFile: string): boolean {
	const normalize = (path: string) => (process.platform === 'win32' ? path.replace(/\\/g, '/').toLowerCase() : path);
	for (let index = from; index <= to; index++) {
		const identityFile = SSH_CONFIG_IDENTITY_FILE.exec(lines[index].text)?.[1];
		if (identityFile !== undefined && normalize(identityFile.replace(/^"(.*)"$/, '$1')) === normalize(keyFile)) {
			return true;
		}
	}
	return false;
}

function configuredHost(view: SSHConfigView, name: string): { host?: string; hostname?: string } {
	const block = view.blocks.get(name)?.[0];
	if (!block) return {};
	let host: string | undefined;
	let hostname: string | undefined;
	for (let index = block.first; index <= block.last; index++) {
		const { text } = view.lines[index];
		host ??= /^[ \t]*Host[ \t]+(.+)$/.exec(text)?.[1].trim();
		hostname ??= /^[ \t]*HostName[ \t]+(.+)$/.exec(text)?.[1].trim();
	}
	return { ...(host && { host }), ...(hostname && { hostname }) };
}

/**
 * The config with markers around its legacy blocks and without `removing`'s blocks. A removed block
 * takes one line break with it, the one before it when it ends the file, so removing the block
 * `addSSHKey` last appended restores the file it appended to.
 */
function renderSSHConfig(view: SSHConfigView, removing?: string): string {
	const { config, lines } = view;
	const lineBreakOf = (line: SSHConfigLine) =>
		config[line.end - 1] !== '\n' ? '' : config[line.end - 2] === '\r' ? '\r\n' : '\n';
	const removed = new Uint8Array(lines.length);
	const beginAfter = new Map<number, string>();
	const endAfter = new Map<number, { name: string; lineBreak: string }>();
	for (const [name, named] of view.blocks) {
		for (const block of named) {
			if (name === removing) removed.fill(1, block.first, block.last + 1);
			else if (block.legacy) {
				beginAfter.set(block.first, name);
				endAfter.set(block.last, { name, lineBreak: lineBreakOf(lines[block.first]) });
			}
		}
	}

	let rendered = '';
	for (let index = 0; index < lines.length; index++) {
		if (removed[index]) continue;
		const line = lines[index];
		rendered += config.slice(line.start, line.end);
		const begin = beginAfter.get(index);
		if (begin !== undefined) rendered += SSH_CONFIG_BEGIN + begin + lineBreakOf(line);
		const end = endAfter.get(index);
		if (end) {
			const lineBreak = lineBreakOf(line);
			rendered += lineBreak ? SSH_CONFIG_END + end.name + lineBreak : end.lineBreak + SSH_CONFIG_END + end.name;
		}
	}
	const lastLine = lines.at(-1);
	if (lastLine && removed[lines.length - 1] && !lineBreakOf(lastLine)) rendered = rendered.replace(/\r?\n$/, '');
	return rendered;
}

async function readSSHConfigFile(configFile: string): Promise<string | undefined> {
	try {
		return await readFile(configFile, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
}

/**
 * Replace the config so that a crash leaves the old file or the new one, never a truncated file that
 * would disable every key on the node. A symlinked config is replaced at its target, keeping the link.
 */
async function writeSSHConfig(configFile: string, contents: string): Promise<void> {
	const target = await realpath(configFile).catch(() => configFile);
	const mode = (await stat(target).catch(() => undefined))?.mode;
	const temporaryFile = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
	let handle: FileHandle | undefined;
	try {
		handle = await open(temporaryFile, 'wx', 0o600);
		await handle.writeFile(contents, 'utf8');
		if (mode !== undefined) await handle.chmod(mode & 0o777);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporaryFile, target);
	} catch (error) {
		await handle?.close().catch(() => {});
		await unlink(temporaryFile).catch(() => {});
		throw error;
	}
	let directory: FileHandle | undefined;
	try {
		directory = await open(dirname(target), 'r');
		await directory.sync();
	} catch (error) {
		// the new config is already in place; only its survival across a power loss is in doubt
		if (!isUnsupportedSyncError(error)) {
			harperLogger?.warn(
				`Unable to sync ${dirname(target)} after rewriting the SSH config: ${(error as Error).message}`
			);
		}
	} finally {
		await directory?.close().catch(() => {});
	}
}

let startupMigration: Promise<void> | undefined;

/**
 * `migrateSSHConfig`, once per process. Called on the main thread before any worker thread starts or
 * any listener binds, when no SSH key operation can be writing the config.
 */
export function migrateSSHConfigOnce(): Promise<void> {
	startupMigration ??= migrateSSHConfig();
	return startupMigration;
}

/**
 * Writes BEGIN/END lines around the blocks of a config written before blocks had them, and logs what it
 * found. Never rejects: on failure the config stays as it was, and every operation still reads it as
 * if migrated.
 */
export async function migrateSSHConfig(): Promise<void> {
	try {
		const { sshDir, configFile } = getSSHPaths(undefined);
		const config = await readSSHConfigFile(configFile);
		if (config === undefined) return;
		const view = readSSHConfig(config, sshDir);
		let marked = 0;
		for (const named of view.blocks.values()) marked += named.filter((block) => block.legacy).length;
		if (marked) await writeSSHConfig(configFile, renderSSHConfig(view));

		const unmanaged = (await listSSHKeyNames(sshDir)).filter((name) => !view.blocks.has(name));
		const findings = [
			marked && `added BEGIN/END lines around ${marked} key block(s)`,
			unmanaged.length && `found no block it can manage for key(s) ${unmanaged.join(', ')}`,
			view.unterminated.size &&
				`found a BEGIN line with no END line for key(s) ${[...view.unterminated.keys()].join(', ')}`,
		].filter(Boolean);
		if (!findings.length) return;
		const summary = `SSH config ${configFile}: ${findings.join('; ')}`;
		if (unmanaged.length || view.unterminated.size) harperLogger?.warn(summary);
		else harperLogger?.info(summary);
	} catch (error) {
		harperLogger?.error(`Unable to add BEGIN/END lines to the SSH config: ${(error as Error)?.message ?? error}`);
	}
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
