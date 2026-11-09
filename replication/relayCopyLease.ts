/**
 * Relay eligibility (harper-pro#1299). A base copy applies rows without log entries, so a follower streaming this
 * node's log of an origin while a pass runs could pass rows it would never be sent. Each inbound pass holds a slot for
 * its database until it settles, and senders withhold other origins while any slot is live. Process-local shared
 * memory, persisted nowhere: a restart clears every slot, and the slot of a thread that stops renewing lapses.
 */
const SLOTS = 8;
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
			auditStore.getUserSharedBuffer(['relay-copy-lease', database], new ArrayBuffer(SLOTS * 8))
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

export interface RelayCopyLease {
	/** Extends the slot, or claims another if it lapsed and was taken; releases instead once the pass stopped. */
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
	{ clock = Date.now, settleDeadlineMs = RELAY_COPY_SETTLE_DEADLINE_MS } = {}
): RelayCopyLease | undefined {
	const slots = leaseSlots(auditStore, database);
	let held: { index: number; expiry: bigint } | undefined;
	const claim = () => {
		const now = clock();
		const expiry = millis(now + RELAY_COPY_LEASE_TTL_MS);
		for (let index = 0; index < SLOTS; index++) {
			const current = Atomics.load(slots, index);
			if (current <= millis(now) && Atomics.compareExchange(slots, index, current, expiry) === current) {
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
			else claim();
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
