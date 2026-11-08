// Nothing about which address a node dials is written to hdb_nodes: every node shares those rows.
import { isIP } from 'node:net';
import { urlToNodeName } from '../core/server/nodeName.ts';
import * as env from '../core/utility/environment/environmentManager.js';
import { CONFIG_PARAMS } from '../core/utility/hdbTerms.ts';
import { createBackoff, type Backoff } from './backoff.ts';
import { PATH_PRIVATE, PATH_PUBLIC, PATH_PUBLIC_FALLBACK } from './sharedStatusSlots.ts';

export const PRIVATE_DIAL_TIMEOUT_MS = 10_000;
export const PRIVATE_IDENTIFY_TIMEOUT_MS = 30_000;
const CANARY_TIMEOUT_MS = 60_000;
// Matches subscriptionManager's RECONNECT_STAGGER_MS: opening many TLS connections at once spikes memory.
export const PROMOTION_STAGGER_MS = 50;

export interface PrivateUrl {
	url: string;
	network: string;
}

export interface Dial {
	url: string;
	path: number;
	privateUrl?: string;
	pathKey?: string;
}

export interface PrivatePathWaiter {
	probePrivatePath(privateUrl: string): Promise<boolean>;
	promoteToPrivatePath(pathKey: string): boolean;
	isWaitingFor(pathKey: string): boolean;
}

export const PATH_NAMES: Record<number, string> = {
	[PATH_PUBLIC]: 'public',
	[PATH_PRIVATE]: 'private',
	[PATH_PUBLIC_FALLBACK]: 'public-fallback',
};

/**
 * Only `wss:`: a receiver identifies a TLS dialer by its certificate, but a plain-ws dialer by its source
 * address, which a private network changes. The URL is published, so it must not carry credentials or a
 * query, and ws refuses one with a fragment.
 */
function isUsablePrivateUrl(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	try {
		const url = new URL(value);
		return url.protocol === 'wss:' && url.hostname !== '' && !url.username && !url.password && !url.search && !url.hash;
	} catch {
		return false;
	}
}

/**
 * The well-formed entries of a `privateUrls` value, as stored in `hdb_nodes.private_urls`. Peer rows and
 * `add_node_back` requests never pass config validation, so every reader goes through this.
 */
export function normalizePrivateUrls(value: unknown): PrivateUrl[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const urls: PrivateUrl[] = [];
	for (const entry of value) {
		// createWebSocket recognizes a TLS URL by its lowercase scheme
		if (isUsablePrivateUrl(entry?.url) && typeof entry.network === 'string' && entry.network !== '')
			urls.push({ url: 'wss:' + entry.url.slice(4), network: entry.network });
	}
	return urls.length ? urls : undefined;
}

export function samePrivateUrls(a: unknown, b: unknown): boolean {
	const left = normalizePrivateUrls(a) ?? [];
	const right = normalizePrivateUrls(b) ?? [];
	return (
		left.length === right.length &&
		left.every((entry, i) => entry.url === right[i].url && entry.network === right[i].network)
	);
}

export function ownPrivateUrls(): PrivateUrl[] | undefined {
	return normalizePrivateUrls(env.get(CONFIG_PARAMS.REPLICATION_PRIVATEURLS));
}

export function localNetworks(): Set<string> {
	const networks = new Set<string>();
	const network = env.get(CONFIG_PARAMS.REPLICATION_NETWORK);
	if (typeof network === 'string' && network !== '') networks.add(network);
	for (const entry of ownPrivateUrls() ?? []) networks.add(entry.network);
	return networks;
}

export function privateUrlOn(peer: any, networks: Set<string>): string | undefined {
	if (networks.size === 0) return undefined;
	return normalizePrivateUrls(peer?.private_urls)?.find((entry) => networks.has(entry.network))?.url;
}

/**
 * The SNI and certificate name the public URL's dial uses, for a dial to another address of the same node:
 * the node name when it is a hostname; otherwise the public URL's hostname, sent as SNI only when it is not
 * an IP. Matches what ws and node:tls derive from the public URL, so a private dial succeeds exactly when
 * the public one would and an SNI proxy routes it to the same place.
 */
export function publicTlsIdentity(publicUrl: string, nodeName?: string): { servername: string; checkHost: string } {
	const publicHost = urlToNodeName(publicUrl) ?? '';
	const servername = nodeName && !isIP(nodeName) ? nodeName : isIP(publicHost) ? '' : publicHost;
	return { servername, checkHost: servername || publicHost };
}

/**
 * What `add_node` / `add_node_back` say a peer advertises: undefined when the message is from a release
 * that does not carry the field (leave the row alone), null when it advertises nothing and the row still
 * holds an old advertisement (ensureNode patches, so the field has to be cleared explicitly).
 */
export function receivedPrivateUrls(message: any, existing: any): PrivateUrl[] | null | undefined {
	if (message == null || !('private_urls' in message)) return undefined;
	return normalizePrivateUrls(message.private_urls) ?? (existing?.private_urls ? null : undefined);
}

/** Two nodes behind one SNI proxy can advertise the same private URL, so outages are per peer identity too. */
export function privatePathKey(privateUrl: string, identity: string): string {
	return `${identity} ${privateUrl}`;
}

interface Outage {
	privateUrl: string;
	backoff: Backoff;
	waiters: Set<PrivatePathWaiter>;
	canary?: PrivatePathWaiter;
	probing?: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

// Per-thread outage state; replication/DESIGN.md non-obvious behavior 37 has the recovery rules.
export class PrivatePaths {
	#outages = new Map<string, Outage>();
	#setTimer: typeof setTimeout;
	#clearTimer: typeof clearTimeout;
	#random: () => number;

	constructor(options: { setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout; random?: () => number } = {}) {
		this.#setTimer = options.setTimer ?? setTimeout;
		this.#clearTimer = options.clearTimer ?? clearTimeout;
		this.#random = options.random ?? Math.random;
	}

	choose(publicUrl: string, privateUrl: string | undefined, pathKey: string, waiter: PrivatePathWaiter): Dial {
		if (!privateUrl) return { url: publicUrl, path: PATH_PUBLIC };
		const outage = this.#outages.get(pathKey);
		if (!outage || outage.canary === waiter) return { url: privateUrl, path: PATH_PRIVATE, privateUrl, pathKey };
		outage.waiters.add(waiter);
		return { url: publicUrl, path: PATH_PUBLIC_FALLBACK, privateUrl, pathKey };
	}

	failed(pathKey: string, privateUrl: string, waiter: PrivatePathWaiter): boolean {
		let outage = this.#outages.get(pathKey);
		const started = !outage;
		if (!outage) {
			outage = {
				privateUrl,
				backoff: createBackoff({ initialMs: 5_000, maxMs: 300_000, minMs: 1_000, random: this.#random }),
				waiters: new Set(),
			};
			this.#outages.set(pathKey, outage);
		}
		if (outage.canary === waiter) this.#endTrial(outage);
		outage.waiters.add(waiter);
		if (!outage.canary && !outage.timer && !outage.probing) this.#scheduleProbe(pathKey, outage);
		return started;
	}

	identified(pathKey: string): boolean {
		const outage = this.#outages.get(pathKey);
		if (!outage) return false;
		this.#outages.delete(pathKey);
		this.#clearTimer(outage.timer);
		let delay = 0;
		for (const waiter of outage.waiters) {
			this.#setTimer(() => {
				if (!waiter.isWaitingFor(pathKey)) return;
				const renewed = this.#outages.get(pathKey);
				if (renewed) renewed.waiters.add(waiter);
				else waiter.promoteToPrivatePath(pathKey);
			}, delay).unref?.();
			delay += PROMOTION_STAGGER_MS;
		}
		return true;
	}

	forget(pathKey: string | undefined, waiter: PrivatePathWaiter): void {
		const outage = pathKey && this.#outages.get(pathKey);
		if (!outage) return;
		outage.waiters.delete(waiter);
		if (outage.canary === waiter) {
			this.#endTrial(outage);
			this.#scheduleProbe(pathKey, outage);
		}
	}

	#endTrial(outage: Outage) {
		outage.canary = undefined;
		this.#clearTimer(outage.timer);
		outage.timer = undefined;
	}

	#scheduleProbe(pathKey: string, outage: Outage) {
		outage.timer = this.#setTimer(() => {
			outage.timer = undefined;
			this.#probe(pathKey, outage);
		}, outage.backoff.nextDelay());
		outage.timer.unref?.();
	}

	async #probe(pathKey: string, outage: Outage) {
		for (const waiter of outage.waiters) if (!waiter.isWaitingFor(pathKey)) outage.waiters.delete(waiter);
		const [prober] = outage.waiters;
		if (!prober) {
			this.#outages.delete(pathKey);
			return;
		}
		let reachable = false;
		outage.probing = true;
		try {
			reachable = await prober.probePrivatePath(outage.privateUrl);
		} catch {
			reachable = false;
		} finally {
			outage.probing = false;
		}
		if (this.#outages.get(pathKey) !== outage) return;
		if (!reachable) {
			this.#scheduleProbe(pathKey, outage);
			return;
		}
		for (const waiter of outage.waiters) {
			if (!waiter.promoteToPrivatePath(pathKey)) continue;
			outage.waiters.delete(waiter);
			outage.canary = waiter;
			outage.timer = this.#setTimer(() => {
				if (outage.canary === waiter) this.failed(pathKey, outage.privateUrl, waiter);
			}, CANARY_TIMEOUT_MS);
			outage.timer.unref?.();
			return;
		}
		this.#scheduleProbe(pathKey, outage);
	}
}

export const privatePaths = new PrivatePaths();
