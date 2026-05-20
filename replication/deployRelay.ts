import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { URL } from 'node:url';
import { buildMultipartBody } from '../core/bin/multipartBuilder.ts';
import { get } from '../core/utility/environment/environmentManager.js';
import { CONFIG_PARAMS } from '../core/utility/hdbTerms.ts';
import * as logger from '../core/utility/logging/harper_logger.js';

interface NodeLike {
	name?: string;
	url?: string;
	host?: string;
	port?: number;
	verify_tls?: boolean;
	rejectUnauthorized?: boolean;
	/** Test/proxy override for the operations API base URL. */
	operationsApiUrl?: string;
}

interface NodeRelayResult {
	node: string | undefined;
	status: 'success' | 'failed';
	message?: string;
	reason?: string;
	statusCode?: number;
	[key: string]: unknown;
}

/**
 * Injectable dependencies — keeps relayDeployToNode unit-testable without mocking ESM
 * modules. Production callers use the default (real `create_authentication_tokens` over
 * the replication WS).
 */
export interface RelayDeps {
	mintToken: (node: NodeLike) => Promise<string>;
}

const defaultDeps: RelayDeps = {
	mintToken: mintOperationToken,
};

// CLI/transport-only fields that must never be replayed to a peer. The streaming-deploy
// origin's `req` carries a few internal flags (e.g. the staged payload path, progress
// emitter) that have no meaning on the peer side and would only confuse its validation.
const NON_FORWARDABLE_FIELDS = new Set([
	'payload', // the Readable is exhausted on the origin; peers receive the file part
	'progress', // ProgressEmitter is local to the origin
	'hdb_user', // peer authenticates the request itself; don't forward our identity
	'fastifyResponse',
	'baseRequest',
	'baseResponse',
]);

/**
 * Relay a streamed `deploy_component` request to a single peer over direct HTTPS,
 * bypassing the WebSocket replication frame which can't carry multi-GB payloads.
 *
 * Flow:
 *  1. Mint a short-lived operation token via the existing replication WS connection
 *     (`create_authentication_tokens` runs against the peer's auth context, so the token
 *     it returns is scoped to the replication user the peer already trusts).
 *  2. Re-stream the staged payload file as the file part of a multipart/form-data POST
 *     to the peer's operations API. The payload is read from disk fresh per relay attempt
 *     so retries (handled by the caller) get a usable stream.
 *  3. Parse the JSON response and return per-peer status.
 *
 * The peer processes the request as a normal local deploy (with `replicated: false` so it
 * doesn't fan out further). Failures here are returned as a `failed` result; the caller
 * decides whether one peer failing aborts the whole deploy (see HarperFast/harper#524's
 * "per-peer status with retry" semantics).
 */
export async function relayDeployToNode(
	node: NodeLike,
	req: Record<string, unknown>,
	payloadPath: string,
	deps: RelayDeps = defaultDeps
): Promise<NodeRelayResult> {
	const fields = buildForwardableFields(req);
	let payloadSize: number;
	try {
		payloadSize = (await stat(payloadPath)).size;
	} catch (err) {
		return {
			node: node.name,
			status: 'failed',
			reason: `staged payload missing: ${(err as Error).message}`,
		};
	}

	let token: string;
	try {
		token = await deps.mintToken(node);
	} catch (err) {
		return {
			node: node.name,
			status: 'failed',
			reason: `token mint failed: ${(err as Error).message ?? String(err)}`,
		};
	}

	const target = resolveOperationsApiUrl(node);
	const multipart = buildMultipartBody(fields, {
		name: 'payload',
		filename: 'package.tar.gz',
		contentType: 'application/gzip',
		stream: createReadStream(payloadPath),
	});

	try {
		const response = await sendMultipart(target, token, multipart, node, payloadSize);
		return { node: node.name, status: 'success', ...response };
	} catch (err: any) {
		return {
			node: node.name,
			status: 'failed',
			reason: err?.message ?? String(err),
			statusCode: err?.statusCode,
		};
	}
}

async function mintOperationToken(node: NodeLike): Promise<string> {
	// `create_authentication_tokens` against an already-authenticated peer connection
	// returns a token tied to the connection's user (no username/password needed).
	// Dynamic-import to avoid pulling the full replicator (and its transitive deps) into
	// every consumer of this module — production code that calls relayDeployToNode has the
	// replicator loaded anyway, so the cost is paid once and cached.
	const { sendOperationToNode } = await import('./replicator.ts');
	const response: any = await sendOperationToNode(node, { operation: 'create_authentication_tokens' }, undefined);
	const token = response?.operation_token ?? response?.results?.operation_token;
	if (!token || typeof token !== 'string') {
		throw new Error('peer did not return an operation_token');
	}
	return token;
}

function buildForwardableFields(req: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(req)) {
		if (key.startsWith('_') || NON_FORWARDABLE_FIELDS.has(key)) continue;
		out[key] = value;
	}
	// Critical: the peer must NOT re-replicate. Without this the deploy would fan out from
	// each peer back to every other node, which would either loop or storm depending on the
	// replication implementation.
	out.replicated = false;
	return out;
}

function resolveOperationsApiUrl(node: NodeLike): URL {
	// A node config can override the operations API URL directly (used by tests and by
	// deployments that put the ops API behind a proxy). Otherwise fall back to the local
	// node's configured ops API port; cluster topologies typically use uniform ports.
	if (node.operationsApiUrl) return new URL(node.operationsApiUrl);
	const securePort = get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_SECUREPORT);
	const insecurePort = get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT);
	const port = node.port ?? securePort ?? insecurePort ?? 9925;
	const protocol = securePort ? 'https:' : 'http:';
	const hostname = extractHostname(node);
	return new URL(`${protocol}//${hostname}:${port}/`);
}

function extractHostname(node: NodeLike): string {
	if (node.host) return node.host;
	if (node.url) {
		try {
			return new URL(node.url).hostname;
		} catch {
			// fall through
		}
	}
	if (node.name) {
		// node.name is sometimes "host" and sometimes "host:port" — strip the port.
		const colon = node.name.lastIndexOf(':');
		return colon > 0 && /^\d+$/.test(node.name.slice(colon + 1)) ? node.name.slice(0, colon) : node.name;
	}
	throw new Error('node has no hostname (missing name/url/host)');
}

interface MultipartBody {
	contentType: string;
	stream: NodeJS.ReadableStream;
}

function sendMultipart(
	target: URL,
	token: string,
	multipart: MultipartBody,
	node: NodeLike,
	contentLengthHint: number
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
		// Per-node TLS verification flag, mirroring how setNode reads it (`verify_tls` from
		// the node config maps to `rejectUnauthorized`). Default: verify, matching WS
		// replication's default posture.
		const verifyTls = node.rejectUnauthorized ?? node.verify_tls ?? true;
		const req = request(
			{
				protocol: target.protocol,
				hostname: target.hostname,
				port: target.port || (target.protocol === 'https:' ? 443 : 80),
				method: 'POST',
				path: '/',
				headers: {
					'Content-Type': multipart.contentType,
					'Transfer-Encoding': 'chunked',
					'Authorization': `Bearer ${token}`,
					// SNI hint for the cluster-CA-verifying peer; matches WS replication.
					'Host': target.hostname,
				},
				// Reuse the cluster's TLS trust posture: verify peer cert against the cluster
				// CAs when verifyTls is enabled (default). The same flag governs replication WS.
				rejectUnauthorized: verifyTls,
				servername: target.hostname,
			},
			(res) => {
				let body = '';
				res.setEncoding('utf8');
				res.on('data', (chunk) => (body += chunk));
				res.on('end', () => {
					const statusCode = res.statusCode ?? 0;
					if (statusCode >= 200 && statusCode < 300) {
						try {
							resolve(JSON.parse(body));
						} catch {
							resolve({ message: body });
						}
					} else {
						const err = new Error(extractErrorMessage(body) || `HTTP ${statusCode}`);
						(err as any).statusCode = statusCode;
						reject(err);
					}
				});
			}
		);
		req.on('error', reject);
		multipart.stream.on('error', (err) => {
			req.destroy(err);
			reject(err);
		});
		logger.debug?.(
			`Relaying deploy to ${node.name ?? target.hostname} via ${target.href} (~${formatBytes(contentLengthHint)})`
		);
		multipart.stream.pipe(req);
	});
}

function extractErrorMessage(body: string): string | undefined {
	if (!body) return undefined;
	try {
		const parsed = JSON.parse(body);
		return parsed?.error ?? parsed?.message ?? body.slice(0, 200);
	} catch {
		return body.slice(0, 200);
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}
