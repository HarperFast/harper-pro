export function normalizeWebSocketCloseReason(reason: unknown): string | undefined {
	if (reason === undefined) return undefined;
	let text: string;
	try {
		text = String(reason);
	} catch {
		text = 'Replication connection error';
	}
	if (Buffer.byteLength(text) <= 123) return text;
	let truncated = '';
	let bytes = 0;
	for (const character of text) {
		const characterBytes = Buffer.byteLength(character);
		if (bytes + characterBytes > 120) break;
		truncated += character;
		bytes += characterBytes;
	}
	return truncated + '...';
}
