import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Readable } from 'node:stream';
import { decode as cborDecode } from 'cbor-x';

export type LeaderHTTPTarget = {
	url: string;
	authorization: string;
	rejectUnauthorized: boolean;
};

/**
 * Socket inactivity, not total duration. A leader that predates streamed `package_component` sends
 * nothing until it has built the whole archive, so this has to outlast that.
 */
export const LEADER_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export function postToLeader(
	target: LeaderHTTPTarget,
	operation: { operation: string; [key: string]: any },
	idleTimeoutMs: number = LEADER_IDLE_TIMEOUT_MS
): Promise<IncomingMessage> {
	const body = JSON.stringify(operation);
	const url = new URL(target.url);
	const isHttps = url.protocol === 'https:';
	const options = {
		hostname: url.hostname,
		port: url.port ? parseInt(url.port, 10) : isHttps ? 443 : 80,
		path: url.pathname + url.search,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/cbor',
			'Authorization': target.authorization,
			'Content-Length': Buffer.byteLength(body),
		},
	};
	return new Promise((resolve, reject) => {
		let response: IncomingMessage | undefined;
		const onResponse = (incoming: IncomingMessage) => {
			response = incoming;
			resolve(incoming);
		};
		const request = isHttps
			? httpsRequest({ ...options, rejectUnauthorized: target.rejectUnauthorized }, onResponse)
			: httpRequest(options, onResponse);
		// Covers the response body too. Once headers have arrived the request's own error goes nowhere, so the
		// response carries it to whoever is reading the archive.
		request.setTimeout(idleTimeoutMs, () =>
			(response ?? request).destroy(
				new Error(`${operation.operation} to the leader sent nothing for ${idleTimeoutMs}ms`)
			)
		);
		request.on('error', reject);
		request.end(body);
	});
}

export async function readLeaderResponse(response: IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	for await (const chunk of response) chunks.push(chunk);
	const responseBody = Buffer.concat(chunks);
	const contentType = response.headers['content-type'] ?? '';
	const statusCode = response.statusCode ?? 0;

	if (statusCode < 200 || statusCode >= 300) {
		let reason: unknown = responseBody.toString('utf8');
		try {
			reason =
				(contentType.includes('cbor') ? cborDecode(responseBody) : JSON.parse(reason as string))?.error ?? reason;
		} catch {}
		reason = String(reason).replace(/\s+/g, ' ').trim().slice(0, 500);
		throw new Error(`Leader request failed: ${statusCode} ${response.statusMessage}${reason ? `: ${reason}` : ''}`);
	}

	if (contentType.includes('application/cbor')) {
		return cborDecode(responseBody);
	}
	return JSON.parse(responseBody.toString('utf8'));
}

/**
 * A `package_component` answer as an extractable payload: the archive itself when the leader streamed it,
 * else the base64 payload of the `{ project, payload }` envelope. Leaders that predate `stream` answer with
 * the envelope rather than refusing it, because operation validation has always allowed unknown keys.
 */
export async function readPackageResponse(response: IncomingMessage): Promise<string | Readable> {
	const statusCode = response.statusCode ?? 0;
	if (statusCode >= 200 && statusCode < 300 && /\bgzip\b/.test(response.headers['content-type'] ?? '')) return response;
	return (await readLeaderResponse(response)).payload;
}
