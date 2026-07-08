import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Helpers for cloning the leader's JWT signing keys onto a new node. All nodes in a cluster must
 * share the same JWT keys so a token issued by one node validates on the others; a node that ends up
 * without a complete set (e.g. private key present but passphrase missing) cannot issue or verify
 * tokens and reports "no encryption keys". These helpers make the fetch resilient to transient leader
 * hiccups and surface a hard failure rather than silently leaving a node half-provisioned.
 */

export const JWT_KEY_CLONE_RETRIES = 3;
export const JWT_KEY_CLONE_RETRY_DELAY_MS = 250;

/**
 * Extracts JWT key material from a `get_key` response. The operations layer wraps a bare string return
 * as `{ message: <key> }` over HTTP, while the cert-auth replication path can resolve to the string
 * directly, so accept either shape. Returns undefined when there is no usable, non-empty string —
 * which the caller treats as a retryable empty response rather than writing garbage to disk.
 */
export function extractKeyMaterial(response: unknown): string | undefined {
	const key = typeof response === 'string' ? response : (response as { message?: unknown } | null)?.message;
	return typeof key === 'string' && key.length > 0 ? key : undefined;
}

/**
 * Fetches one JWT key from the leader via `requestKey`, retrying transient failures — a rejected
 * request or an empty/garbage response while the leader is still warming up. Returns the key material
 * as a non-empty string, or throws (with the last failure as `cause`) once the retry budget is spent
 * so the caller can avoid finalizing a non-viable clone.
 */
export async function fetchJWTKeyWithRetry(
	requestKey: () => Promise<unknown>,
	keyName: string,
	retries: number = JWT_KEY_CLONE_RETRIES,
	delayMs: number = JWT_KEY_CLONE_RETRY_DELAY_MS
): Promise<string> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			const key = extractKeyMaterial(await requestKey());
			if (key !== undefined) return key;
			lastError = new Error(`leader returned an empty response for JWT key '${keyName}'`);
		} catch (err) {
			lastError = err;
		}
		if (attempt < retries) await sleep(delayMs);
	}
	throw new Error(`Unable to clone JWT key '${keyName}' from leader after ${retries} attempts`, { cause: lastError });
}
