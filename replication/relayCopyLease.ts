/**
 * Relay eligibility (harper-pro#1299). A base copy applies rows without log entries, so a follower streaming this
 * node's log of an origin while a pass runs could pass rows it would never be sent. Each inbound pass holds a slot for
 * its database until it settles, and senders withhold other origins while any slot is live. Process-local shared
 * memory, persisted nowhere: a restart clears every slot, and the slot of a thread that stops renewing lapses.
 */
import { randomUUID } from 'node:crypto';

const SLOTS = 8;
// after the slots: how many claims this process has made, so a walk can tell a pass started and ended under it
const CLAIMS = SLOTS;
export const RELAY_COPY_LEASE_TTL_MS = 15_000;
const RENEW_INTERVAL_MS = 3_000;
/** From a pass's last applied row: a settle that never commits must not withhold relaying for the connection's life. */
export const RELAY_COPY_SETTLE_DEADLINE_MS = 300_000;
const slotsByStore = new WeakMap<object, Map<string, BigInt64Array>>();

function leaseSlots(auditStore: any, database: string): BigInt64Array {
	let byDatabase = slotsByStore.get(auditStore);
	if (!byDatabase) slotsByStore.set(auditStore, (byDatabase = new Map()));
	let slots = byDatabase.get(database);
	if (!slots) {
		slots = new BigInt64Array(
			auditStore.getUserSharedBuffer(['relay-copy-lease', database], new ArrayBuffer((SLOTS + 1) * 8))
		);
		byDatabase.set(database, slots);
	}
	return slots;
}

const millis = (time: number) => BigInt(Math.floor(time));

export function relayCopyLeaseHeld(auditStore: any, database: string, now = Date.now()): boolean {
	if (!auditStore?.getUserSharedBuffer) return false;
	const slots = leaseSlots(auditStore, database);
	const at = millis(now);
	for (let index = 0; index < SLOTS; index++) if (Atomics.load(slots, index) > at) return true;
	return false;
}

export function relayCopyLeaseClaims(auditStore: any, database: string): bigint {
	return auditStore?.getUserSharedBuffer ? Atomics.load(leaseSlots(auditStore, database), CLAIMS) : 0n;
}

export interface RelayCopyLease {
	/** Extends the slot, or claims another if it lapsed and was taken; releases instead once the pass stopped. Calls `onLost` when no slot is left. */
	renew(): void;
	/** The pass applied its last row: release at the deadline unless it settles first. */
	armSettleDeadline(onExpire: () => void): void;
	/** A new pass on the same connection keeps the slot; its own finish arms the deadline again. */
	disarmSettleDeadline(): void;
	release(): void;
}

/** Claims a slot for an inbound pass, renewed every few seconds while `running()`; undefined when every slot is live. */
export function holdRelayCopyLease(
	auditStore: any,
	database: string,
	running: () => boolean,
	{
		clock = Date.now,
		settleDeadlineMs = RELAY_COPY_SETTLE_DEADLINE_MS,
		onLost = () => {},
	}: { clock?: () => number; settleDeadlineMs?: number; onLost?: () => void } = {}
): RelayCopyLease | undefined {
	const slots = leaseSlots(auditStore, database);
	let held: { index: number; expiry: bigint } | undefined;
	const claim = () => {
		const now = clock();
		const expiry = millis(now + RELAY_COPY_LEASE_TTL_MS);
		for (let index = 0; index < SLOTS; index++) {
			const current = Atomics.load(slots, index);
			if (current <= millis(now) && Atomics.compareExchange(slots, index, current, expiry) === current) {
				Atomics.add(slots, CLAIMS, 1n);
				held = { index, expiry };
				return true;
			}
		}
		held = undefined;
		return false;
	};
	if (!claim()) return;
	let timer: ReturnType<typeof setInterval> | undefined;
	let deadline: ReturnType<typeof setTimeout> | undefined;
	let released = false;
	const lease: RelayCopyLease = {
		renew() {
			if (released) return;
			if (!running()) return lease.release();
			const expiry = millis(clock() + RELAY_COPY_LEASE_TTL_MS);
			if (held && Atomics.compareExchange(slots, held.index, held.expiry, expiry) === held.expiry) held.expiry = expiry;
			else if (!claim()) {
				lease.release();
				onLost();
			}
		},
		armSettleDeadline(onExpire) {
			if (deadline || !held) return;
			deadline = setTimeout(() => {
				lease.release();
				onExpire();
			}, settleDeadlineMs);
			deadline.unref?.();
		},
		disarmSettleDeadline() {
			clearTimeout(deadline);
			deadline = undefined;
		},
		release() {
			released = true;
			clearInterval(timer);
			lease.disarmSettleDeadline();
			if (held) Atomics.compareExchange(slots, held.index, held.expiry, 0n);
			held = undefined;
		},
	};
	timer = setInterval(lease.renew, RENEW_INTERVAL_MS);
	timer.unref?.();
	return lease;
}

/**
 * After a pass that ended without settling (its connection closed, or a restart), the copy reservation it committed
 * stays, and the rows it applied without log entries may sit below later log entries. Relaying stays held back until
 * a later pass from that source settles and releases it, but never for good: a reservation is honored for
 * RESERVATION_HOLD_MS from when this process first saw it with no lease held, long enough for the source to come back
 * and a resumed pass to claim the lease, and not at all once it was created more than RESERVATION_MAX_AGE_MS ago, so
 * one left by an older version never holds relaying after each restart.
 */
export const RESERVATION_HOLD_MS = 30 * 60_000;
export const RESERVATION_MAX_AGE_MS = 24 * 60 * 60_000;
const reservationFirstSeen = new Map<string, Map<string, number>>();

/**
 * `<copy start>:<id>:<created>`. The copy start is the source's last log key, which can be days old, so the age of a
 * reservation is read from the time this node created its token.
 */
export function newPassToken(copyStart: number, now = Date.now()): string {
	return `${copyStart}:${randomUUID()}:${Math.floor(now)}`;
}

/** When this node created the pass token; a token from before creation times were recorded gives its copy start. */
export function passCreatedAt(pass: string): number | undefined {
	const [copyStart, , created] = String(pass).split(':');
	const time = Number(created ?? copyStart);
	return time > 0 ? time : undefined;
}

/** `passes` are the database's unreleased reservation pass tokens; `onExpire` runs once per pass. */
export function reservationHolds(
	database: string,
	passes: Iterable<string>,
	onExpire: (pass: string) => void,
	now = Date.now()
): boolean {
	let seen = reservationFirstSeen.get(database);
	if (!seen) reservationFirstSeen.set(database, (seen = new Map()));
	const current = new Set<string>();
	let holds = false;
	for (const pass of passes) {
		const created = passCreatedAt(pass);
		if (created === undefined || now - created > RESERVATION_MAX_AGE_MS) continue;
		current.add(pass);
		let since = seen.get(pass);
		if (since === undefined) seen.set(pass, (since = now));
		if (now - since < RESERVATION_HOLD_MS) holds = true;
		else if (since !== -1) {
			seen.set(pass, -1);
			onExpire(pass);
		}
	}
	// a released reservation starts over if it ever comes back
	for (const pass of seen.keys()) if (!current.has(pass)) seen.delete(pass);
	return holds;
}
