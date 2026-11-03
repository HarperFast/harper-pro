const PREFIX = 'unnamed-origin-';

function escapeNodeName(nodeName: string): string {
	return nodeName.replace(
		/[^A-Za-z0-9.-]/g,
		(character) => '_' + character.charCodeAt(0).toString(16).padStart(4, '0')
	);
}

/**
 * The name for an origin id a node holds rows for but has no name for (harper-pro#1235): one per (the node
 * that holds it, its id there), the same whichever side derives it, and safe as a transaction-log name, since
 * every character of the node name outside `[A-Za-z0-9.-]` is escaped (an IPv6 literal's `:` included).
 */
export function unnamedOriginName(nodeName: string, id: number): string {
	return `${PREFIX}${id}@${escapeNodeName(nodeName)}`;
}

/** The id behind a name `unnamedOriginName(nodeName, id)` produced for this node, else undefined. */
export function ownUnnamedOriginId(name: string, nodeName: string): number | undefined {
	if (!name.startsWith(PREFIX)) return undefined;
	const at = name.indexOf('@', PREFIX.length);
	if (at < 0) return undefined;
	const id = Number(name.slice(PREFIX.length, at));
	return Number.isSafeInteger(id) && id > 0 && name === unnamedOriginName(nodeName, id) ? id : undefined;
}
