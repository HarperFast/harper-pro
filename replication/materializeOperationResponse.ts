/**
 * Make an operation's result safe to send back over the replication channel.
 *
 * Some operations (notably `get_analytics`) return their rows lazily so the HTTP layer can
 * stream the response: either as a lazy async-iterable, or as an array of still-unresolved
 * per-row promises. Neither survives the single replication message intact — the msgpack
 * encoder throws "Cannot encode a promise" on an array containing promises (which drops the
 * peer connection), and silently encodes a bare async-iterable to `{}` (which drops every
 * row). Both make a `replicated` get_analytics fan-out lose the peer's analytics. Draining
 * the result into a concrete, fully-resolved array before encoding fixes both.
 *
 * The caller attaches a top-level `requestId` to what this returns. Arrays are wrapped as
 * `{ results }`. A plain object, with an ordinary or a null prototype, is copied because an
 * operation may answer with a shared or frozen object. The copy keeps the prototype and every
 * property descriptor, so nothing is read here and the encoder sees what it would have seen on the
 * original, including a non-enumerable `toJSON`. Any other value is returned unchanged. `response`
 * is intentionally `any`, because operation results can have any shape.
 *
 * Assumes operation results are bounded (they are for today's operations): the whole response
 * is buffered in memory here, so a future genuinely-large streaming op forwarded over
 * replication would need a size cap / backpressure rather than this unconditional drain.
 */
export async function materializeOperationResponse(response: any): Promise<any> {
	// Strings and binary (Buffer / typed arrays / ArrayBuffer) are iterable too, but must be
	// sent as-is — draining them would shred a string into characters or a Buffer into a byte
	// array. Only drain genuine row streams (async generators, arrays-of-promises via the
	// branch below, Sets, etc.).
	if (
		response != null &&
		typeof response !== 'string' &&
		!Array.isArray(response) &&
		!ArrayBuffer.isView(response) &&
		!(response instanceof ArrayBuffer) &&
		(response[Symbol.asyncIterator] || response[Symbol.iterator])
	) {
		const collected = [];
		for await (const row of response) {
			collected.push(row);
		}
		response = collected;
	}
	if (Array.isArray(response)) {
		return { results: await Promise.all(response) };
	}
	const prototype = response !== null && typeof response === 'object' ? Object.getPrototypeOf(response) : undefined;
	if (prototype === Object.prototype || prototype === null)
		return Object.create(prototype, Object.getOwnPropertyDescriptors(response));
	return response;
}
