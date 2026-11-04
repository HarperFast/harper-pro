const PREFIX = 'unnamed-origin-';

function escapeNodeName(nodeName: string): string {
	return nodeName.replace(
		/[^A-Za-z0-9.-]/g,
		(character) => '_' + character.charCodeAt(0).toString(16).padStart(4, '0')
	);
}

/**
 * The name for an origin id a node holds rows for but has no name for (harper-pro#1235). Both sides must derive
 * the identical name, and it becomes a transaction-log name on relay, so a node name's other characters (an IPv6
 * literal's `:`) are escaped.
 */
export function unnamedOriginName(nodeName: string, id: number): string {
	return `${PREFIX}${id}@${escapeNodeName(nodeName)}`;
}

export function ownUnnamedOriginId(name: string, nodeName: string): number | undefined {
	if (!name.startsWith(PREFIX)) return undefined;
	const at = name.indexOf('@', PREFIX.length);
	if (at < 0) return undefined;
	const id = Number(name.slice(PREFIX.length, at));
	return Number.isSafeInteger(id) && id > 0 && name === unnamedOriginName(nodeName, id) ? id : undefined;
}
