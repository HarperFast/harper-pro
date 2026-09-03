/**
 * The single normalization point for the `NODE_NAME[4]` capability bag: nothing else in replication may
 * read the raw bag. Wire contract, per-key kinds and the sender-side gating discipline are in DESIGN.md.
 */

/** Bump only for a SHAPE change (frame layout, field meaning). An additive feature gets its own key. */
export const LOCAL_PROTOCOL_VERSION = 2;

/**
 * Descriptive only — nothing disconnects or degrades on it. A floor consulted by mistake closes every
 * link in the mesh at once, with no rollback but a redeploy, so adding one is a separate decision.
 */
export const MINIMUM_PROTOCOL_VERSION = 1;

/** Level at which a peer supports the correlated subscription-setup acknowledgement (harper-pro#642). */
export const SUBSCRIPTION_SETUP_ACK_CAPABILITY = 1;

/** Effective values for one socket: versions and levels are already `min(local, peer)`. */
export interface ResolvedPeerCapabilities {
	protocolVersion: number;
	subscriptionSetupAck: number;
	subscriptionSetupBudgetMs: number | undefined;
}

/** Coerces, because the comparison it replaces did: see the kind table in DESIGN.md. */
function resolveLevel(value: unknown, localLevel: number, absentLevel: number): number {
	const level = Number(value);
	if (Number.isNaN(level)) return absentLevel;
	// A level this build does not implement cannot be used.
	return Math.min(localLevel, Math.max(absentLevel, Math.floor(level)));
}

/** Does NOT coerce, unlike a level, and is never min-clamped: see the kind table in DESIGN.md. */
function resolveBudget(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Keys this build does not know are dropped, so nothing downstream can consult one by accident. */
export function resolvePeerCapabilities(bag: any): ResolvedPeerCapabilities {
	return Object.freeze({
		protocolVersion: resolveLevel(bag?.protocolVersion, LOCAL_PROTOCOL_VERSION, MINIMUM_PROTOCOL_VERSION),
		subscriptionSetupAck: resolveLevel(bag?.subscriptionSetupAck, SUBSCRIPTION_SETUP_ACK_CAPABILITY, 0),
		subscriptionSetupBudgetMs: resolveBudget(bag?.subscriptionSetupBudgetMs),
	});
}

/** A peer that advertised nothing — the pre-registry baseline. */
export const ABSENT_PEER_CAPABILITIES: ResolvedPeerCapabilities = resolvePeerCapabilities(undefined);

/**
 * The budget is passed in, not derived here: it comes from `PING_INTERVAL`, an `env.get` read evaluated
 * when `replicationConnection.ts` loads. Deriving it behind this module's import graph would let an
 * earlier importer evaluate it before config loads and silently advertise a default-derived budget.
 */
export function buildLocalCapabilities(subscriptionSetupBudgetMs: number): Readonly<Record<string, number>> {
	return Object.freeze({
		protocolVersion: LOCAL_PROTOCOL_VERSION,
		subscriptionSetupAck: SUBSCRIPTION_SETUP_ACK_CAPABILITY,
		subscriptionSetupBudgetMs,
	});
}

/** Field comparison, not identity: every handshake resolves a fresh object, so identity always differs. */
export function samePeerCapabilities(a: ResolvedPeerCapabilities | undefined, b: ResolvedPeerCapabilities): boolean {
	return (
		a !== undefined &&
		a.protocolVersion === b.protocolVersion &&
		a.subscriptionSetupAck === b.subscriptionSetupAck &&
		a.subscriptionSetupBudgetMs === b.subscriptionSetupBudgetMs
	);
}

/**
 * The subscription-setup view over a resolved set, separate because the clamp needs the caller's runtime
 * local timeout. The upper bound is what stops a peer disabling the receiver's independent recovery net.
 */
export function subscriptionSetupCapabilityFrom(
	resolved: ResolvedPeerCapabilities,
	localTimeoutMs: number,
	usePeerBudget: boolean
): { supported: boolean; timeoutMs: number } {
	const supported = resolved.subscriptionSetupAck >= SUBSCRIPTION_SETUP_ACK_CAPABILITY;
	const peerBudgetMs = resolved.subscriptionSetupBudgetMs;
	const maxPeerSetupBudgetMs = Math.max(localTimeoutMs * 4, 10 * 60_000);
	const timeoutMs =
		usePeerBudget && supported && peerBudgetMs !== undefined
			? Math.max(localTimeoutMs, Math.min(peerBudgetMs, maxPeerSetupBudgetMs))
			: localTimeoutMs;
	// The setup watchdog hands this straight to `setTimeout`, where a NaN or non-positive value fires on
	// the next tick — on every link at once, since every node advertises the same bag. This bounds the
	// peer-derived branch; `localTimeoutMs` is the caller's own guarantee (`positiveMsOr`).
	return { supported, timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : localTimeoutMs };
}

export interface UnknownCommandState {
	count: number;
	lastCommand: number | undefined;
}

export function createUnknownCommandState(): UnknownCommandState {
	return { count: 0, lastCommand: undefined };
}

/** `command` is whatever the peer put in element 0: all values count, only a safe integer is logged. */
export function noteUnknownCommand(state: UnknownCommandState, command: unknown): number | 'non-numeric' {
	const safe = Number.isSafeInteger(command) ? (command as number) : undefined;
	state.count++;
	state.lastCommand = safe;
	return safe ?? 'non-numeric';
}
