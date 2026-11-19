import assert from 'node:assert';
import {
	ROUTE_SCOPE_KEY,
	cursorRouteScope,
	intersectScope,
	readRouteScope,
	recordRequestScope,
	routeScope,
	sameScope,
	scopeWidens,
	withRouteScopeLock,
} from '#src/replication/routeScope';

function scopeStore(initial) {
	const rows = new Map(initial === undefined ? [] : [[7, initial]]);
	const writes = [];
	return {
		writes,
		getSync: ([key, routeId]) => {
			assert.strictEqual(key, ROUTE_SCOPE_KEY);
			return rows.get(routeId);
		},
		putSync: ([key, routeId], value) => {
			assert.strictEqual(key, ROUTE_SCOPE_KEY);
			rows.set(routeId, value);
			writes.push(value);
		},
	};
}

const excluding = (...tables) => routeScope(true, true, tables);
const listing = (...tables) => routeScope(true, false, tables);

describe('route scope (harper-pro#1142, #1212)', () => {
	it('normalizes the table list so equal scopes compare equal', () => {
		assert.deepStrictEqual(routeScope(true, true, ['b', 'a', 'b']), {
			full: true,
			byDefault: true,
			tables: ['a', 'b'],
		});
		assert.ok(sameScope(excluding('b', 'a'), excluding('a', 'b')));
		assert.ok(!sameScope(excluding('a'), listing('a')));
		assert.ok(!sameScope(excluding('a'), routeScope(false, true, ['a'])));
	});

	it('widens when coverage turns full or a table enters scope, in every mode pair', () => {
		assert.ok(scopeWidens(routeScope(false, true, []), excluding()), 'coverage turning full');
		assert.ok(!scopeWidens(excluding(), routeScope(false, true, [])), 'coverage turning partial narrows');
		// a table whose replicate turned on leaves the excluded list
		assert.ok(scopeWidens(excluding('flipped', 'local'), excluding('local')));
		assert.ok(!scopeWidens(excluding('local'), excluding('local', 'flipped')));
		// an explicit list that gains a table
		assert.ok(scopeWidens(listing('a'), listing('a', 'b')));
		assert.ok(!scopeWidens(listing('a', 'b'), listing('a')));
		// a list naming a table the default scope excluded
		assert.ok(scopeWidens(excluding('b'), listing('a', 'b')));
		assert.ok(!scopeWidens(excluding('b'), listing('a')));
		// a default scope holds tables no explicit list named
		assert.ok(scopeWidens(listing('a', 'b'), excluding()));
	});

	it('intersects to the narrowest scope, in every mode pair', () => {
		assert.deepStrictEqual(intersectScope(excluding('a'), excluding('b')), excluding('a', 'b'));
		assert.deepStrictEqual(intersectScope(listing('a', 'b'), listing('b', 'c')), listing('b'));
		assert.deepStrictEqual(intersectScope(excluding('b'), listing('a', 'b')), listing('a'));
		assert.deepStrictEqual(intersectScope(listing('a', 'b'), excluding('b')), listing('a'));
		assert.strictEqual(intersectScope(excluding(), routeScope(false, true, [])).full, false);
		// what the intersection holds never widens either side
		for (const [a, b] of [
			[excluding('a'), listing('a', 'b')],
			[listing('x'), excluding()],
			[excluding('a'), excluding('b')],
		]) {
			const both = intersectScope(a, b);
			assert.ok(!scopeWidens(a, both) && !scopeWidens(b, both));
		}
	});

	it('records a narrowing before the request and judges widening against the scope recorded before it', () => {
		const dbisDB = scopeStore({ ...excluding('t'), rev: 0, submitted: excluding('t') });
		// the replicate flip: t is in scope now, and the record keeps the older, narrower scope
		const widened = recordRequestScope(dbisDB, 7, excluding(), { legacyFull: true });
		assert.deepStrictEqual(widened, { recorded: excluding('t'), rev: 1, repaired: false });
		assert.ok(scopeWidens(widened.recorded, excluding()));
		assert.deepStrictEqual(
			dbisDB.writes,
			[{ ...excluding('t'), rev: 1, submitted: excluding() }],
			'only a completed copy widens the scope itself'
		);

		const narrowed = recordRequestScope(dbisDB, 7, excluding('t', 'u'), { legacyFull: true });
		assert.deepStrictEqual(narrowed, { recorded: excluding('t'), rev: 2, repaired: false });
		assert.deepStrictEqual(dbisDB.writes.at(-1), { ...excluding('t', 'u'), rev: 2, submitted: excluding('t', 'u') });
		assert.strictEqual(recordRequestScope(dbisDB, 7, excluding('t', 'u'), { legacyFull: true }).rev, 2);
		assert.strictEqual(dbisDB.writes.length, 2, 'an unchanged request writes nothing');
	});

	it('seeds an absent record from the request and an older build’s evidence of partial coverage', () => {
		const fresh = scopeStore();
		assert.deepStrictEqual(recordRequestScope(fresh, 7, excluding('t'), { legacyFull: true }), {
			recorded: excluding('t'),
			rev: 0,
			repaired: false,
		});
		assert.deepStrictEqual(fresh.writes, [{ ...excluding('t'), rev: 0, submitted: excluding('t') }]);

		const partialBefore = scopeStore();
		const { recorded } = recordRequestScope(partialBefore, 7, excluding(), { legacyFull: false });
		assert.ok(scopeWidens(recorded, excluding()), 'a #1092-era row with fullCoverage: false still widens');
		assert.deepStrictEqual(partialBefore.writes, [{ ...routeScope(false, true, []), rev: 0, submitted: excluding() }]);
	});

	it('keeps only coverage on a route that is not full, which never certifies', () => {
		const dbisDB = scopeStore({ ...excluding('t'), rev: 2, submitted: excluding('t') });
		const partial = routeScope(false, true, []);
		assert.deepStrictEqual(
			recordRequestScope(dbisDB, 7, partial, { legacyFull: true }).rev,
			3,
			'losing coverage is a narrowing'
		);
		assert.deepStrictEqual(dbisDB.writes.at(-1), { ...partial, rev: 3, submitted: partial });
		// a table entering scope on a partial route is tracked without a copy
		const tables = routeScope(false, true, ['u']);
		recordRequestScope(dbisDB, 7, tables, { legacyFull: true });
		assert.deepStrictEqual(recordRequestScope(dbisDB, 7, partial, { legacyFull: true }).recorded, tables);
	});

	it('moves the revision on every change in what is asked for, so no copy begun before it promotes', () => {
		// worker A asks for the wider scope; a replacement worker then asks for the narrower one the record already holds
		const dbisDB = scopeStore({ ...excluding('t'), rev: 1, submitted: excluding('t') });
		const widening = recordRequestScope(dbisDB, 7, excluding(), { legacyFull: true });
		const handoff = recordRequestScope(dbisDB, 7, excluding('t'), { legacyFull: true });
		assert.ok(handoff.rev > widening.rev, 'the widening copy must not promote over the narrower request');
		assert.deepStrictEqual(readRouteScope(dbisDB, 7), {
			...excluding('t'),
			rev: handoff.rev,
			submitted: excluding('t'),
		});
		// asking again for the same scope leaves the revision, so a copy on that request still promotes
		assert.strictEqual(recordRequestScope(dbisDB, 7, excluding('t'), { legacyFull: true }).rev, handoff.rev);
	});

	it('writes the record only while holding the route’s cross-thread lock, and refuses while another thread holds it', () => {
		const locks = new Set();
		const dbisDB = Object.assign(scopeStore({ ...excluding('t'), rev: 1 }), {
			tryLock: (key) => {
				const name = String(key[1]);
				if (locks.has(name)) return false;
				locks.add(name);
				return true;
			},
			unlock: (key) => locks.delete(String(key[1])),
		});
		recordRequestScope(dbisDB, 7, excluding('t', 'u'), { legacyFull: true });
		assert.strictEqual(locks.size, 0, 'released after the write');
		assert.strictEqual(dbisDB.writes.length, 1);
		withRouteScopeLock(dbisDB, 7, () => {
			assert.throws(
				() => recordRequestScope(dbisDB, 7, excluding('t', 'u', 'v'), { legacyFull: true }),
				/another thread/
			);
		});
		assert.strictEqual(dbisDB.writes.length, 1, 'nothing written while the lock was held');
		assert.throws(() =>
			withRouteScopeLock(dbisDB, 7, () => {
				throw new Error('failed');
			})
		);
		assert.strictEqual(locks.size, 0, 'released after a failed update');
	});

	it('reads a row that is not a scope as the narrowest one, and propagates a store that cannot be read', () => {
		assert.deepStrictEqual(readRouteScope(scopeStore({ full: 'yes' }), 7), {
			full: false,
			byDefault: false,
			tables: [],
			rev: 0,
			malformed: true,
		});
		assert.deepStrictEqual(readRouteScope(scopeStore({ ...excluding('t'), rev: -1 }), 7).tables, []);
		assert.strictEqual(readRouteScope(scopeStore(), 7), undefined);
		// a repair request reports it, so no saved cursor resumes on the revision the repair writes
		const repair = recordRequestScope(scopeStore({ full: 'yes' }), 7, excluding(), { legacyFull: true });
		assert.strictEqual(repair.repaired, true);
		assert.ok(repair.rev > 1_000_000_000_000, 'no cursor or pass from before the repair holds its revision');
		assert.ok(scopeWidens(repair.recorded, excluding()));
		const unreadable = {
			getSync() {
				throw new Error('closed');
			},
		};
		assert.throws(() => recordRequestScope(unreadable, 7, excluding(), { legacyFull: true }), /closed/);
	});

	it('reads the scope a copy cursor fills, and none from a cursor written before scopes were recorded', () => {
		assert.strictEqual(cursorRouteScope(undefined), undefined);
		assert.strictEqual(cursorRouteScope({ currentTable: 'a' }), undefined);
		assert.deepStrictEqual(cursorRouteScope({ scope: excluding('b', 'a'), scopeRev: 4 }), excluding('a', 'b'));
		assert.deepStrictEqual(cursorRouteScope({ scope: excluding('a'), scopeRev: 'x' }), routeScope(false, false, []));
		assert.deepStrictEqual(cursorRouteScope({ scope: { full: true }, scopeRev: 1 }), routeScope(false, false, []));
	});
});
