/**
 * Position-indexed durability watermark for the bulk-copy resume cursor (harper-pro#699).
 *
 * The copy walk delivers frames in key order; a frame's staged cursor may only be persisted once
 * every blob received for frames at or before it is durably saved. Tracking is by walk position:
 * a transient blob fault at frame G bars persistence only from G onward, so the prefix before G
 * stays eligible and the healing reconnect resumes at the gapped record.
 *
 * Contract: every method is non-throwing and duplicate/stale calls are no-ops — callers run from
 * promise `.finally` chains, commit hooks, and timers where an escaped exception would reject
 * process-owned chains. The barrier never heals within a connection (the blob-gap watchdog's
 * reconnect is the healer, matching `hasBlobGap`); a new connection starts a fresh watermark.
 *
 * Memory is bounded by the count of UNSETTLED blob tags, independent of walk rate: settled tags
 * unlink in O(1), and a staged cursor is only retained when an unsettled tag separates it from
 * the next one (only the last staged cursor below each potential barrier position can ever be
 * returned), so a single hung blob during a fast dense walk holds O(in-flight blobs) state, not
 * O(copied records). The receive timeout settles hung tags retained across COPY_START passes.
 */

export interface CopyCursorValue {
	copyStartTime: number;
	currentTable: any;
	afterKey: any;
	copyOrder: any;
}

interface BlobTagNode {
	index: number;
	remaining: number;
	prev: BlobTagNode | null;
	next: BlobTagNode | null;
}

interface StagedCursorEntry {
	index: number;
	cursor: CopyCursorValue;
}

export class CopyCursorWatermark {
	#pass = 1;
	#frame = 0;
	#barrier = Infinity;
	// Unsettled-blob tags in ascending index order; the head is the lowest frame whose blobs are
	// not all settled. Doubly-linked so a settle anywhere unlinks in O(1).
	#tagHead: BlobTagNode | null = null;
	#tagTail: BlobTagNode | null = null;
	#tagByIndex: Map<number, BlobTagNode> = new Map();
	// Committed-but-not-yet-durable staged cursors in commit (= frame) order.
	#staged: StagedCursorEntry[] = [];
	#stagedHead = 0;

	get currentPass(): number {
		return this.#pass;
	}

	get hasBarrier(): boolean {
		return this.#barrier !== Infinity;
	}

	/**
	 * True once a held barrier has no unsettled blob left below it: the highest pre-barrier cursor
	 * is final and this connection will never persist anything further — the caller should flush
	 * it immediately (the gap watchdog may reconnect at any moment) rather than on the cadence.
	 */
	get barrierDrained(): boolean {
		return this.hasBarrier && (this.#tagHead === null || this.#tagHead.index >= this.#barrier);
	}

	get isDrained(): boolean {
		return this.#stagedHead >= this.#staged.length;
	}

	/** Retained staged-cursor count; observable bound is unsettled-tag count + 1. */
	get stagedCount(): number {
		return this.#staged.length - this.#stagedHead;
	}

	/** Assign the next frame position. Call once per copy frame body, at decode time. */
	beginFrame(): number {
		return ++this.#frame;
	}

	/**
	 * A new COPY_START: staged cursors from the prior pass must never persist under the new
	 * pass's identity (they claim delivery the new walk has not made). Outstanding blob tags and
	 * the barrier are kept — new frames get higher indexes, and the barrier stays latched for the
	 * life of the connection, like `hasBlobGap`.
	 */
	beginPass(): number {
		this.#staged = [];
		this.#stagedHead = 0;
		return ++this.#pass;
	}

	trackBlob(frameIndex: number | undefined): void {
		if (typeof frameIndex !== 'number' || !Number.isFinite(frameIndex)) return;
		// A blob at or past the barrier can never unblock anything on this connection; skip
		// tracking so a permanently-gapped copy holds bounded state.
		if (frameIndex >= this.#barrier) return;
		const existing = this.#tagByIndex.get(frameIndex);
		if (existing) {
			existing.remaining++;
			return;
		}
		const node: BlobTagNode = { index: frameIndex, remaining: 1, prev: this.#tagTail, next: null };
		if (this.#tagTail && this.#tagTail.index > frameIndex) {
			// Frames decode serially so tags arrive in ascending order; tolerate a violation by
			// walking to the ordered position rather than corrupting the head-is-minimum invariant.
			let after = this.#tagTail;
			while (after.prev && after.prev.index > frameIndex) after = after.prev;
			node.prev = after.prev;
			node.next = after;
			if (after.prev) after.prev.next = node;
			else this.#tagHead = node;
			after.prev = node;
		} else if (this.#tagTail) {
			this.#tagTail.next = node;
			this.#tagTail = node;
		} else {
			this.#tagHead = this.#tagTail = node;
		}
		this.#tagByIndex.set(frameIndex, node);
	}

	/**
	 * A tracked blob finished. `gapped` marks a transient save failure: the cursor must never
	 * advance to or past this frame on this connection (the reconnect re-streams from before it).
	 * An unrecoverable-source blob settles with `gapped: false` — the cursor intentionally
	 * advances past those (harper-pro#403; backfill is #388's job). Duplicate settles are no-ops.
	 */
	settleBlob(frameIndex: number | undefined, gapped: boolean): void {
		if (typeof frameIndex !== 'number' || !Number.isFinite(frameIndex)) return;
		if (gapped && frameIndex < this.#barrier) {
			this.#barrier = frameIndex;
			// Staged entries at or past the barrier can never persist on this connection; purge them
			// (ordered, so truncate the tail) so a long-lived gapped copy holds bounded state.
			let end = this.#staged.length;
			while (end > this.#stagedHead && this.#staged[end - 1].index >= frameIndex) end--;
			this.#staged.length = end;
		}
		const node = this.#tagByIndex.get(frameIndex);
		if (!node || node.remaining <= 0) return;
		node.remaining--;
		if (node.remaining === 0) {
			this.#tagByIndex.delete(frameIndex);
			if (node.prev) node.prev.next = node.next;
			else this.#tagHead = node.next;
			if (node.next) node.next.prev = node.prev;
			else this.#tagTail = node.prev;
			// This tag was a separator: staged cursors it kept apart are now in one inter-tag gap, and
			// only the last of them can ever be returned — merge, or a hung LOW tag would let staged
			// entries accrue one per settling frame for its whole lifetime (the |staged| <= unsettled
			// tags + 1 bound). Bounds itself: with merging on every unlink the affected span stays small.
			this.#mergeStagedBetween(node.prev ? node.prev.index : -Infinity, node.next ? node.next.index : Infinity);
		}
	}

	#mergeStagedBetween(lowIndex: number, highIndex: number): void {
		let first = -1;
		let last = -1;
		for (let i = this.#stagedHead; i < this.#staged.length; i++) {
			const index = this.#staged[i].index;
			if (index <= lowIndex) continue;
			if (index >= highIndex) break;
			if (first === -1) first = i;
			last = i;
		}
		if (first !== -1 && last > first) this.#staged.splice(first, last - first);
	}

	/** Stage a committed copy frame's cursor. Stale-pass and past-barrier stagings are dropped. */
	stageCursor(frameIndex: number | undefined, passId: number, cursor: CopyCursorValue): void {
		if (typeof frameIndex !== 'number' || !Number.isFinite(frameIndex)) return;
		if (passId !== this.#pass || !cursor || frameIndex >= this.#barrier) return;
		// Only the last staged cursor below each unsettled tag can ever be returned by
		// takeDurable(), so when no unsettled tag separates the tail from this frame the tail can
		// never surface — replace it. This is the memory bound: |staged| <= unsettled tags + 1.
		const tail = this.#staged.length > this.#stagedHead ? this.#staged[this.#staged.length - 1] : undefined;
		if (tail) {
			if (frameIndex < tail.index) return;
			let nextTag = this.#tagHead;
			while (nextTag && nextTag.index <= tail.index) nextTag = nextTag.next;
			const separated = nextTag !== null && nextTag.index <= frameIndex;
			if (!separated) {
				tail.index = frameIndex;
				tail.cursor = cursor;
				return;
			}
		}
		this.#staged.push({ index: frameIndex, cursor });
	}

	/**
	 * Consume and return the highest staged cursor that is durable-eligible: all blobs for frames
	 * at or before it have settled without a gap. Null when nothing new is eligible.
	 */
	takeDurable(): CopyCursorValue | null {
		if (this.#stagedHead >= this.#staged.length) return null; // zero-cost outside copy mode
		const limit = Math.min(this.#tagHead !== null ? this.#tagHead.index : Infinity, this.#barrier);
		let taken: CopyCursorValue | null = null;
		while (this.#stagedHead < this.#staged.length && this.#staged[this.#stagedHead].index < limit) {
			taken = this.#staged[this.#stagedHead].cursor;
			this.#stagedHead++;
		}
		if (this.#stagedHead >= this.#staged.length && this.#stagedHead > 0) {
			this.#staged = [];
			this.#stagedHead = 0;
		}
		return taken;
	}
}
