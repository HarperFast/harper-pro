import { isValidFloor } from '../core/resources/originClosedFloor.ts';

export interface ShardingBootstrapState {
	initializer: string;
	agreement: string;
	run: string;
	phase: 'began' | 'witnessed' | 'active';
	floors?: Record<string, number>;
	localFloor?: number;
	localOrigin?: string;
	scope?: string;
}

const historyKey = Symbol.for('sharding-bootstrap-history');
const baselineKey = Symbol.for('sharding-initial-baseline');

export function readShardingHistory(catalog: any, layout: string): ShardingBootstrapState | undefined {
	return catalog.getSync([historyKey, layout]);
}

export function readShardingBaseline(catalog: any, layout: string): ShardingBootstrapState | undefined {
	return catalog.getSync([baselineKey, layout]);
}

export function inheritShardingHistory(catalog: any, layout: string, state: ShardingBootstrapState): void {
	if (state.phase !== 'active' || !state.run || !state.floors)
		throw new Error('Only established sharding history can be inherited');
	validateShardingFloors(state.floors, Object.keys(state.floors));
	const committed = catalog.transactionSync(
		(transaction: any) => {
			const previous = transaction.getSync([historyKey, layout]);
			if (previous?.phase === 'active') return true;
			if (previous?.phase === 'witnessed' && previous.run !== state.run)
				throw new Error('Conflicting witnessed sharding history requires recovery');
			const { scope: _scope, localFloor: _localFloor, localOrigin: _localOrigin, ...inherited } = state;
			if (previous?.phase === 'witnessed') {
				if (
					previous.agreement !== state.agreement ||
					previous.initializer !== state.initializer ||
					Object.keys(previous.floors ?? {}).length !== Object.keys(state.floors).length ||
					Object.keys(state.floors).some((origin) => previous.floors?.[origin] !== state.floors[origin])
				)
					throw new Error('Conflicting witnessed sharding history requires recovery');
				// A peer can activate between our inspection and activation RPC. Keep this root's
				// durable start and scope; the peer's local fields never certify this root.
				transaction.putSync([historyKey, layout], { ...previous, phase: 'active' });
			} else transaction.putSync([historyKey, layout], inherited);
			return true;
		},
		{ retryOnBusy: true }
	);
	if (committed !== true) throw new Error('Inherited sharding history did not commit');
}

export function validateShardingFloors(
	floors: unknown,
	members: readonly string[]
): asserts floors is Record<string, number> {
	if (
		!members.length ||
		!floors ||
		typeof floors !== 'object' ||
		Array.isArray(floors) ||
		Object.keys(floors).length !== members.length ||
		members.some((member) => !Object.hasOwn(floors, member) || !isValidFloor(floors[member]))
	)
		throw new Error('Sharding bootstrap requires a valid closed-origin floor for every agreed member');
}

export function advanceShardingHistory(
	catalog: any,
	layout: string,
	next: ShardingBootstrapState,
	initialBaseline = false,
	expectedRun?: string
): void {
	const ranks = { began: 0, witnessed: 1, active: 2 };
	if (!Object.hasOwn(ranks, next.phase)) throw new Error('Invalid sharding bootstrap phase');
	if (typeof next.run !== 'string' || !next.run)
		throw new Error('Sharding bootstrap requires a coordinator run identity');
	if (initialBaseline && next.phase !== 'witnessed')
		throw new Error('An initial sharding baseline requires its durable ready witness');
	if (initialBaseline && (typeof next.scope !== 'string' || !next.scope))
		throw new Error('An initial sharding baseline requires its local conversion scope');
	const key = [historyKey, layout];
	const committed = catalog.transactionSync(
		(transaction: any = catalog) => {
			const previous: ShardingBootstrapState | undefined = transaction.getSync(key);
			if (previous) {
				if (previous.run !== next.run) {
					if (expectedRun !== previous.run || previous.phase !== 'began' || next.phase !== 'began')
						throw new Error('Sharding bootstrap coordinator run changed; stale transition refused');
				} else if (previous.agreement !== next.agreement || previous.initializer !== next.initializer)
					throw new Error('Sharding bootstrap membership changed within a coordinator run');
				if (initialBaseline && previous.phase !== 'began' && !transaction.getSync([baselineKey, layout]))
					throw new Error('Prior sharding history cannot certify an empty replacement root');
				if (ranks[previous.phase] > ranks[next.phase]) return true;
			} else if (expectedRun !== undefined || next.phase !== 'began') {
				throw new Error('Sharding bootstrap has no durable initial grant');
			}
			if (next.localFloor !== undefined && !isValidFloor(next.localFloor))
				throw new Error('Sharding bootstrap requires a valid local origin floor');
			if (previous?.run === next.run && previous.localFloor !== undefined && previous.localFloor !== next.localFloor)
				throw new Error('Sharding bootstrap local origin floor changed');
			if (previous?.localOrigin !== undefined && previous.localOrigin !== next.localOrigin)
				throw new Error('Sharding bootstrap local origin identity changed');
			if (next.phase !== 'began' && !next.floors) throw new Error('Sharding bootstrap has no durable origin baseline');
			if (next.phase === 'active' && previous?.phase === 'began')
				throw new Error('Sharding bootstrap has no durable ready witness');
			if (
				previous?.floors &&
				(Object.keys(previous.floors).length !== Object.keys(next.floors ?? {}).length ||
					Object.keys(previous.floors).some((member) => previous.floors[member] !== next.floors?.[member]))
			)
				throw new Error('Sharding bootstrap origin baseline changed');
			transaction.putSync(key, next);
			if (initialBaseline) transaction.putSync([baselineKey, layout], next);
			if (
				transaction.getSync(key)?.phase !== next.phase ||
				(initialBaseline && transaction.getSync([baselineKey, layout])?.agreement !== next.agreement)
			)
				throw new Error('Sharding bootstrap state did not commit');
			return true;
		},
		{ retryOnBusy: true }
	);
	if (committed !== true) throw new Error('Sharding bootstrap state did not commit');
}

export function frozenShardingOriginFloor(
	state: ShardingBootstrapState | undefined,
	origin: string
): number | undefined {
	return state && (state.localOrigin === undefined || state.localOrigin === origin) && isValidFloor(state.localFloor)
		? state.localFloor
		: undefined;
}
