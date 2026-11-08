/**
 * Which address a replication connection dials: a peer's private URL on one of this node's networks, or its
 * public `url`. The choice is per thread and per socket; nothing about it is written to `hdb_nodes`, which
 * every node shares.
 */
import { isIP } from 'node:net';
import { urlToNodeName } from '../core/server/nodeName.ts';
import * as env from '../core/utility/environment/environmentManager.js';
import { CONFIG_PARAMS } from '../core/utility/hdbTerms.ts';
import { createBackoff, type Backoff } from './backoff.ts';
import { PATH_PRIVATE, PATH_PUBLIC, PATH_PUBLIC_FALLBACK } from './sharedStatusSlots.ts';

// Shorter than replication.pingTimeout: an unreachable private address delays the public dial by this much.
export const PRIVATE_DIAL_TIMEOUT_MS = 10_000;
// A canary that neither reaches the handshake nor fails within this long is treated as failed.
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
}

export interface PrivatePathWaiter {
	/** Whether the private URL now completes TLS, the peer certificate check and the WebSocket upgrade. */
	probePrivatePath(privateUrl: string): Promise<boolean>;
	/** Redials over the private URL; false when this connection is no longer on that URL's public fallback. */
	promoteToPrivatePath(privateUrl: string): boolean;
}

export const PATH_NAMES: Record<number, string> = {
	[PATH_PUBLIC]: 'public',
	[PATH_PRIVATE]: 'private',
	[PATH_PUBLIC_FALLBACK]: 'public-fallback',
};

/**
 * Only `wss:`: a receiver identifies a TLS dialer by its certificate, but a plain-ws dialer by its source
 * address, which a private network changes. The URL is published, so it must not carry credentials.
 */
function isUsablePrivateUrl(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	try {
		const url = new URL(value);
		return url.protocol === 'wss:' && url.hostname !== '' && !url.username && !url.password;
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
		if (isUsablePrivateUrl(entry?.url) && typeof entry.network === 'string' && entry.network !== '')
			urls.push({ url: entry.url, network: entry.network });
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

/** The networks this node dials from: `replication.network` and every network it is reachable on. */
export function localNetworks(): Set<string> {
	const networks = new Set<string>();
	const network = env.get(CONFIG_PARAMS.REPLICATION_NETWORK);
	if (typeof network === 'string' && network !== '') networks.add(network);
	for (const entry of ownPrivateUrls() ?? []) networks.add(entry.network);
	return networks;
}

/** The first private URL the peer advertises on one of `networks`. */
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

interface Outage {
	backoff: Backoff;
	waiters: Set<PrivatePathWaiter>;
	canary?: PrivatePathWaiter;
	probing?: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * Per-thread health of private URLs. A private socket that ends before the peer is identified marks its URL
 * down; while it is down, one probe for it runs on a backoff. A probe that gets through promotes one waiting
 * connection (the canary) to dial privately; only when the canary's peer is identified is the URL healthy
 * again, and the rest of the waiters follow, staggered. A probe reaching the WebSocket upgrade does not
 * prove the peer accepts this node, so the canary, not the probe, resets the backoff.
 */
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

	choose(publicUrl: string, privateUrl: string | undefined, waiter: PrivatePathWaiter): Dial {
		if (!privateUrl) return { url: publicUrl, path: PATH_PUBLIC };
		const outage = this.#outages.get(privateUrl);
		if (!outage || outage.canary === waiter) return { url: privateUrl, path: PATH_PRIVATE, privateUrl };
		// a connection sent to the fallback waits for the outage to end, whether or not its own dial failed
		outage.waiters.add(waiter);
		return { url: publicUrl, path: PATH_PUBLIC_FALLBACK, privateUrl };
	}

	/** Returns true when this starts an outage, so the caller reports it once. */
	failed(privateUrl: string, waiter: PrivatePathWaiter): boolean {
		let outage = this.#outages.get(privateUrl);
		const started = !outage;
		if (!outage) {
			outage = {
				backoff: createBackoff({ initialMs: 5_000, maxMs: 300_000, minMs: 1_000, random: this.#random }),
				waiters: new Set(),
			};
			this.#outages.set(privateUrl, outage);
		}
		if (outage.canary === waiter) this.#endTrial(outage);
		outage.waiters.add(waiter);
		if (!outage.canary && !outage.timer && !outage.probing) this.#scheduleProbe(privateUrl, outage);
		return started;
	}

	/** The peer was identified over `privateUrl`. Returns true when this ends an outage. */
	identified(privateUrl: string): boolean {
		const outage = this.#outages.get(privateUrl);
		if (!outage) return false;
		this.#outages.delete(privateUrl);
		this.#clearTimer(outage.timer);
		let delay = 0;
		for (const waiter of outage.waiters) {
			this.#setTimer(() => waiter.promoteToPrivatePath(privateUrl), delay).unref?.();
			delay += PROMOTION_STAGGER_MS;
		}
		return true;
	}

	forget(privateUrl: string | undefined, waiter: PrivatePathWaiter): void {
		const outage = privateUrl && this.#outages.get(privateUrl);
		if (!outage) return;
		outage.waiters.delete(waiter);
		if (outage.canary === waiter) {
			this.#endTrial(outage);
			this.#scheduleProbe(privateUrl, outage);
		}
	}

	#endTrial(outage: Outage) {
		outage.canary = undefined;
		this.#clearTimer(outage.timer);
		outage.timer = undefined;
	}

	#scheduleProbe(privateUrl: string, outage: Outage) {
		outage.timer = this.#setTimer(() => {
			outage.timer = undefined;
			this.#probe(privateUrl, outage);
		}, outage.backoff.nextDelay());
		outage.timer.unref?.();
	}

	async #probe(privateUrl: string, outage: Outage) {
		const [prober] = outage.waiters;
		if (!prober) {
			this.#outages.delete(privateUrl);
			return;
		}
		let reachable = false;
		outage.probing = true;
		try {
			reachable = await prober.probePrivatePath(privateUrl);
		} catch {
			// an unreachable path, like any other failed probe
		} finally {
			outage.probing = false;
		}
		if (this.#outages.get(privateUrl) !== outage) return;
		if (!reachable) {
			this.#scheduleProbe(privateUrl, outage);
			return;
		}
		for (const waiter of outage.waiters) {
			outage.waiters.delete(waiter);
			if (!waiter.promoteToPrivatePath(privateUrl)) continue;
			outage.canary = waiter;
			outage.timer = this.#setTimer(() => {
				if (outage.canary === waiter) this.failed(privateUrl, waiter);
			}, CANARY_TIMEOUT_MS);
			outage.timer.unref?.();
			return;
		}
		// nothing is waiting on the public fallback any more; the next dial tries the private URL
		this.#outages.delete(privateUrl);
	}
}

export const privatePaths = new PrivatePaths();
