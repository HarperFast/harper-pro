import { isMainThread } from 'node:worker_threads';
import { ResidencyPlacementError } from '../core/resources/residencyMaps.ts';
import { isValidFloor } from '../core/resources/originClosedFloor.ts';

// One shared load on writes. Higher bits invalidate cold admission across workers;
// a bound writer holds bit 1 until its catalog maximum is durable.
export const ORIGIN_READY = 1;
export const ORIGIN_BOUND_BUSY = 2;
export const recoveryBoundKey = Symbol.for('sharding-origin-recovery-bound');
export const recoveryBoundSourceKey = Symbol.for('sharding-origin-recovery-source');
const states = new WeakMap<object, Map<string, Int32Array>>();

export function originReadyWord(root: any, database: string): Int32Array {
	let databases = states.get(root);
	if (!databases) states.set(root, (databases = new Map()));
	let word = databases.get(database);
	if (!word) {
		word = new Int32Array(root.getUserSharedBuffer(['sharding-origin-ready', database], new ArrayBuffer(4)));
		databases.set(database, word);
	}
	return word;
}

export async function recordShardingOriginBound(
	root: any,
	catalog: any,
	database: string,
	bound: number,
	source: string
): Promise<void> {
	if (!isMainThread) throw new Error('Sharding origin bounds must be persisted by the main thread');
	if (!isValidFloor(bound)) throw new Error('Invalid sharding origin recovery bound');
	const word = originReadyWord(root, database);
	const previousState = Atomics.load(word, 0);
	const key = [recoveryBoundKey, database];
	if (previousState & ORIGIN_READY && catalog.getSync(key) >= bound) return;
	const held = ((previousState + 4) & ~ORIGIN_READY) | ORIGIN_BOUND_BUSY;
	if (previousState & ORIGIN_BOUND_BUSY || Atomics.compareExchange(word, 0, previousState, held) !== previousState)
		throw new ResidencyPlacementError('Waiting for another sharding origin recovery bound update', 503);
	try {
		const committed = catalog.transactionSync(
			(transaction: any) => {
				if (!(transaction.getSync(key) >= bound)) {
					transaction.putSync(key, bound);
					transaction.putSync([recoveryBoundSourceKey, database], source);
				}
				return true;
			},
			{ retryOnBusy: true }
		);
		if (committed !== true) throw new Error('Sharding origin recovery bound did not commit');
		// Even a retry of an equal bound must flush: a previous flush may have failed.
		await catalog.flush({ allowWriteStall: true });
	} finally {
		Atomics.compareExchange(word, 0, held, held & ~ORIGIN_BOUND_BUSY);
	}
}
