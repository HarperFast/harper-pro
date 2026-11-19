/**
 * What a route's history covers: whether the peer replicates every table to this node (`full`) and the request's table
 * list in the request's own shape (`byDefault` lists the excluded tables, otherwise the included ones).
 */
export interface RouteScope {
	full: boolean;
	byDefault: boolean;
	tables: string[];
}

/**
 * The narrowest scope a route accepted progress under since its last completed copy, and the scope its last request
 * asked for (`submitted`). `rev` moves on a narrowing and on any change of the submitted scope, so a copy promotes
 * only if no other request intervened.
 */
type RecordedRouteScope = RouteScope & { rev: number; submitted?: RouteScope; malformed?: true };

export const ROUTE_SCOPE_KEY = Symbol.for('routeScope');

export function routeScope(full: boolean, byDefault: boolean, tables: Iterable<string>): RouteScope {
	return { full, byDefault, tables: [...new Set(tables)].sort() };
}

/** Whether `current` reaches history `recorded` never held: coverage turning full, or a table newly in scope. */
export function scopeWidens(recorded: RouteScope, current: RouteScope): boolean {
	if (current.full && !recorded.full) return true;
	if (recorded.byDefault) {
		const excluded = new Set(recorded.tables);
		if (!current.byDefault) return current.tables.some((table) => excluded.has(table));
		const stillExcluded = new Set(current.tables);
		return recorded.tables.some((table) => !stillExcluded.has(table));
	}
	// an explicit list never held any table outside it, and a default scope names no bound on those
	if (current.byDefault) return true;
	const included = new Set(recorded.tables);
	return current.tables.some((table) => !included.has(table));
}

export function intersectScope(a: RouteScope, b: RouteScope): RouteScope {
	const full = a.full && b.full;
	if (a.byDefault && b.byDefault) return routeScope(full, true, [...a.tables, ...b.tables]);
	if (!a.byDefault && !b.byDefault) {
		const inB = new Set(b.tables);
		return routeScope(
			full,
			false,
			a.tables.filter((table) => inB.has(table))
		);
	}
	const [byDefault, explicit] = a.byDefault ? [a, b] : [b, a];
	const excluded = new Set(byDefault.tables);
	return routeScope(
		full,
		false,
		explicit.tables.filter((table) => !excluded.has(table))
	);
}

export function sameScope(a: RouteScope, b: RouteScope): boolean {
	return (
		a.full === b.full &&
		a.byDefault === b.byDefault &&
		a.tables.length === b.tables.length &&
		a.tables.every((table, index) => table === b.tables[index])
	);
}

function isScope(value: any): value is RouteScope {
	return (
		value !== null &&
		typeof value === 'object' &&
		typeof value.full === 'boolean' &&
		typeof value.byDefault === 'boolean' &&
		Array.isArray(value.tables) &&
		value.tables.every((table: unknown) => typeof table === 'string')
	);
}

function isRecordedScope(value: any): value is RecordedRouteScope {
	return isScope(value) && Number.isSafeInteger((value as any).rev) && (value as any).rev >= 0;
}

/**
 * The route's recorded scope, undefined when it has none. A row that is not a scope reads as the narrowest one, so the
 * next full request copies and its completion rewrites the row.
 */
export function readRouteScope(dbisDB: any, routeId: number): RecordedRouteScope | undefined {
	const value = dbisDB.getSync([ROUTE_SCOPE_KEY, routeId]);
	if (value === undefined) return undefined;
	if (!isRecordedScope(value)) return { full: false, byDefault: false, tables: [], rev: 0, malformed: true };
	const submitted = isScope(value.submitted)
		? routeScope(value.submitted.full, value.submitted.byDefault, value.submitted.tables)
		: undefined;
	return { ...routeScope(value.full, value.byDefault, value.tables), rev: value.rev, ...(submitted && { submitted }) };
}

/**
 * Synchronous, so a narrowing is in the database's WAL before the request that narrows is sent: every progress write
 * that request leads to comes later in the same WAL.
 */
export function writeRouteScope(dbisDB: any, routeId: number, scope: RecordedRouteScope): void {
	dbisDB.putSync([ROUTE_SCOPE_KEY, routeId], {
		full: scope.full,
		byDefault: scope.byDefault,
		tables: scope.tables,
		rev: scope.rev,
		...(scope.submitted && {
			submitted: { full: scope.submitted.full, byDefault: scope.submitted.byDefault, tables: scope.submitted.tables },
		}),
	});
}

interface RequestScopeContext {
	/** An older build's evidence of partial coverage, for seeding an absent record. */
	legacyFull: boolean;
}

/**
 * Runs a read and write of the route's record under a cross-thread lock: connections for one route on two workers
 * overlap at a failover handoff, and neither may overwrite a revision the other wrote after its read. Synchronous, so a
 * held lock throws and the caller reconnects or retries rather than waits. A store without the lock runs it unlocked.
 */
export function withRouteScopeLock<T>(dbisDB: any, routeId: number, update: () => T): T {
	if (typeof dbisDB?.tryLock !== 'function') return update();
	const key = [ROUTE_SCOPE_KEY, routeId];
	if (!dbisDB.tryLock(key)) throw new Error(`The scope record of route ${routeId} is being written by another thread`);
	try {
		return update();
	} finally {
		dbisDB.unlock(key);
	}
}

/**
 * Records what a request on the route covers and returns the scope recorded before it, which widening is judged
 * against, with the revision now stored. Seeded on first sight from the request. A full route's record only narrows
 * here; it widens when a copy completes. A route that is not full never certifies, so only its coverage is kept.
 */
export function recordRequestScope(
	dbisDB: any,
	routeId: number,
	current: RouteScope,
	{ legacyFull }: RequestScopeContext
): { recorded: RouteScope; rev: number; repaired: boolean } {
	return withRouteScopeLock(dbisDB, routeId, () => {
		const stored = readRouteScope(dbisDB, routeId);
		const recorded = stored ?? { ...current, full: current.full && legacyFull, rev: 0 };
		const proven = current.full ? intersectScope(recorded, current) : current;
		const narrowed = current.full ? !sameScope(proven, recorded) : recorded.full;
		// a replacement worker narrowing back to the proven scope still changes what was last asked for
		const resubmitted = stored !== undefined && !(stored.submitted && sameScope(stored.submitted, current));
		const rev = narrowed || resubmitted ? recorded.rev + 1 : recorded.rev;
		if (!stored || rev !== recorded.rev || !sameScope(proven, recorded))
			writeRouteScope(dbisDB, routeId, { ...proven, rev, submitted: current });
		return {
			recorded: routeScope(recorded.full, recorded.byDefault, recorded.tables),
			rev,
			repaired: stored?.malformed === true,
		};
	});
}

/** The scope a copy cursor says its pass fills; undefined for a cursor written before scopes were recorded. */
export function cursorRouteScope(cursor: { scope?: unknown; scopeRev?: unknown } | undefined): RouteScope | undefined {
	const scope: any = cursor?.scope;
	if (scope === undefined || scope === null) return undefined;
	if (
		typeof scope !== 'object' ||
		typeof scope.full !== 'boolean' ||
		typeof scope.byDefault !== 'boolean' ||
		!Array.isArray(scope.tables) ||
		!scope.tables.every((table: unknown) => typeof table === 'string') ||
		!Number.isSafeInteger(cursor.scopeRev)
	)
		return { full: false, byDefault: false, tables: [] };
	return routeScope(scope.full, scope.byDefault, scope.tables);
}
