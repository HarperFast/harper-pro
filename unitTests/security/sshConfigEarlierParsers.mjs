/**
 * How earlier versions read and delete key blocks in `ssh/config`, frozen here so the tests can show that a
 * config in the current format still works on a node rolled back to one of them.
 *
 * - `regexParser`: every release through v5.3.0-beta.3, and Harper 4.x.
 * - `anchoredParser`: `security/sshKeyOperations.ts` as of #910 (c2ad335), types removed.
 */
const SSH_CONFIG_KEY_COMMENT = /^[ \t]*#([a-zA-Z0-9-_]+)[ \t]*$/;
const SSH_CONFIG_SECTION_START = /^[ \t]*(?:Host|Match)(?:[ \t]*=|[ \t]+)/i;
const SSH_CONFIG_BLANK_OR_COMMENT = /^[ \t]*(?:#.*)?$/;

function findSSHConfigBlocks(config, name) {
	const lines = [];
	for (let start = 0; start < config.length;) {
		const newline = config.indexOf('\n', start);
		const end = newline === -1 ? config.length : newline;
		lines.push({ start, text: config.slice(start, end).replace(/\r$/, '') });
		start = end + 1;
	}
	const startsSection = (index) => SSH_CONFIG_SECTION_START.test(lines[index].text);
	const sectionHeadedBy = (index) => {
		for (let next = index + 1; next < lines.length; next++) {
			const { text } = lines[next];
			if (SSH_CONFIG_KEY_COMMENT.test(text)) return undefined;
			if (!SSH_CONFIG_BLANK_OR_COMMENT.test(text)) return startsSection(next) ? next : undefined;
		}
		return undefined;
	};
	const isKeyHeader = (index) => SSH_CONFIG_KEY_COMMENT.test(lines[index].text) && sectionHeadedBy(index) !== undefined;

	const blocks = [];
	for (let index = 0; index < lines.length; index++) {
		if (SSH_CONFIG_KEY_COMMENT.exec(lines[index].text)?.[1] !== name) continue;
		let end = (sectionHeadedBy(index) ?? index) + 1;
		while (end < lines.length && !startsSection(end) && !isKeyHeader(end)) end++;
		blocks.push([lines[index].start, end < lines.length ? lines[end].start : config.length]);
		index = end - 1;
	}
	return blocks;
}

function hostAndHostname(configBlock) {
	const host = configBlock.match(/^Host\s+(.+)$/m)?.[1]?.trim();
	const hostname = configBlock.match(/^\s*HostName\s+(.+)$/m)?.[1]?.trim();
	return { ...(host && { host }), ...(hostname && { hostname }) };
}

export const anchoredParser = {
	get(config, name) {
		const [block] = findSSHConfigBlocks(config, name);
		return block ? hostAndHostname(config.slice(...block)) : {};
	},
	delete(config, name) {
		let remaining = '';
		let keptFrom = 0;
		for (const [start, end] of findSSHConfigBlocks(config, name)) {
			remaining += config.slice(keptFrom, start);
			keptFrom = end;
		}
		return (remaining + config.slice(keptFrom)).trim();
	},
};

const regexBlockPattern = (name) =>
	new RegExp(`#${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\S\\s]*?IdentitiesOnly yes`, 'g');

export const regexParser = {
	get(config, name) {
		const match = config.match(regexBlockPattern(name));
		return match ? hostAndHostname(match[0]) : {};
	},
	delete(config, name) {
		return config.replace(regexBlockPattern(name), '').trim();
	},
};
