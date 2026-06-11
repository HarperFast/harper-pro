/**
 * HTTP helpers for talking to a started Harper node.
 */
import { setTimeout as delay } from 'node:timers/promises';

/** Build a `Basic <base64>` authorization header value. */
export function basicAuth({ username, password }) {
	return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

/**
 * fetch() with retry on connection failure. Lifted from integrationTests/cluster/clusterShared.mjs.
 */
export function fetchWithRetry(url, options) {
	let retries = options?.retries ?? 20;
	let response = fetch(url, options);
	if (retries > 0) {
		response = response.catch(() => {
			options ??= {};
			options.retries = retries - 1;
			return delay(500).then(() => fetchWithRetry(url, options));
		});
	}
	return response;
}

/**
 * Issue an authenticated request against a node's HTTP API.
 * @param {object} node a started harper context ({ httpURL, admin })
 * @param {string} method HTTP method
 * @param {string} path path beginning with /
 * @param {object} [opts]
 * @param {*} [opts.body] JSON-serialized unless contentType is set
 * @param {string} [opts.contentType] override Content-Type (e.g. text/csv)
 * @param {boolean} [opts.retry=false] use fetchWithRetry
 */
export async function nodeFetch(node, method, path, { body, contentType, retry = false } = {}) {
	const headers = { Authorization: basicAuth(node.admin) };
	let payload;
	if (body !== undefined) {
		if (contentType && contentType !== 'application/json') {
			headers['Content-Type'] = contentType;
			payload = body;
		} else {
			headers['Content-Type'] = 'application/json';
			payload = JSON.stringify(body);
		}
	}
	const url = node.httpURL + path;
	const doFetch = retry ? fetchWithRetry : fetch;
	return doFetch(url, { method, headers, body: payload });
}

/** Poll path on every node until each responds with a status < 500. */
export async function waitForHttp(nodes, path, { tries = 40, intervalMs = 500 } = {}) {
	for (const node of nodes) {
		let ok = false;
		for (let i = 0; i < tries; i++) {
			try {
				const res = await nodeFetch(node, 'GET', path);
				if (res.status < 500) {
					ok = true;
					break;
				}
			} catch {
				// node still restarting
			}
			await delay(intervalMs);
		}
		if (!ok) throw new Error(`Timed out waiting for ${node.httpURL}${path} to respond (<500)`);
	}
}
