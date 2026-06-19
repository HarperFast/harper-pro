/**
 * A base copy streams each table to completion before the next, so the iteration order decides which
 * tables converge first. `orderTablesForCopy` puts control-plane tables (hdb_deployment, hdb_nodes)
 * ahead of bulk tables (hdb_analytics) so a large, largely node-local table can't gate convergence of
 * the small tables that gate cluster operations like deploy_component (harper-pro#421).
 *
 * The ordering must be a deterministic, stable function of the table-name set: the leader's resume
 * skip-loop trusts that every table before the cursor's currentTable was already copied, which only
 * holds if a re-run produces the identical order. These tests pin both the priority placement and the
 * stability (insertion order preserved among equal-rank tables).
 */

import { expect } from 'chai';
import {
	orderTablesForCopy,
	isCopyResumeOrderCompatible,
	COPY_PRIORITY_TABLES,
	COPY_DEPRIORITIZED_TABLES,
} from '#src/replication/replicationConnection';

describe('orderTablesForCopy', () => {
	it('moves control-plane tables to the front and bulk tables to the back', () => {
		// insertion order as observed in the field: hdb_analytics sits AHEAD of hdb_deployment — the bug.
		const input = ['hdb_analytics', 'hdb_user', 'hdb_deployment', 'hdb_role', 'hdb_nodes'];
		const out = orderTablesForCopy(input);
		expect(out).to.deep.equal(['hdb_deployment', 'hdb_nodes', 'hdb_user', 'hdb_role', 'hdb_analytics']);
	});

	it('keeps priority tables in their listed order, not their input order', () => {
		// hdb_nodes appears before hdb_deployment in the input, but the listed priority order wins.
		const out = orderTablesForCopy(['hdb_nodes', 'hdb_deployment']);
		expect(out).to.deep.equal(['hdb_deployment', 'hdb_nodes']);
		expect(out).to.deep.equal(COPY_PRIORITY_TABLES);
	});

	it('preserves insertion order among ordinary (equal-rank) tables', () => {
		const input = ['c_table', 'a_table', 'b_table'];
		expect(orderTablesForCopy(input)).to.deep.equal(['c_table', 'a_table', 'b_table']);
	});

	it('is deterministic: re-running on the same set yields the same order (resume safety)', () => {
		const input = ['hdb_analytics', 'z', 'hdb_deployment', 'a', 'hdb_nodes', 'm'];
		const first = orderTablesForCopy(input);
		const second = orderTablesForCopy([...input]);
		expect(first).to.deep.equal(second);
	});

	it('leaves a user database (no control-plane names) in unchanged insertion order', () => {
		const input = ['orders', 'customers', 'products'];
		expect(orderTablesForCopy(input)).to.deep.equal(input);
	});

	it('returns an empty array for no tables', () => {
		expect(orderTablesForCopy([])).to.deep.equal([]);
	});

	it('does not drop or duplicate any table (permutation of the input set)', () => {
		const input = ['hdb_analytics', 'hdb_deployment', 'hdb_nodes', 'x', 'y', 'z'];
		const out = orderTablesForCopy(input);
		expect(out).to.have.lengthOf(input.length);
		expect([...out].sort()).to.deep.equal([...input].sort());
	});

	it('orders multiple deprioritized tables after all middle tables, in listed order', () => {
		// guards the rank formula if COPY_DEPRIORITIZED_TABLES ever grows beyond one entry
		const input = ['middle', ...[...COPY_DEPRIORITIZED_TABLES].reverse(), 'hdb_deployment'];
		const out = orderTablesForCopy(input);
		expect(out[0]).to.equal('hdb_deployment');
		expect(out.slice(-COPY_DEPRIORITIZED_TABLES.length)).to.deep.equal(COPY_DEPRIORITIZED_TABLES);
		expect(out[out.length - COPY_DEPRIORITIZED_TABLES.length - 1]).to.equal('middle');
	});
});

/**
 * The leader's resume skip-loop assumes every table before the cursor's currentTable was already copied
 * — true only if the resume runs under the SAME copy order that built the cursor. isCopyResumeOrderCompatible
 * is the guard: only a cursor whose copyOrder matches the leader's current COPY_ORDER_VERSION may be
 * trusted; anything else (stale version, or a pre-versioning cursor with no copyOrder) must force a full
 * recopy. These cases are the data-loss-relevant logic during a mixed-version upgrade (harper-pro#421).
 */
describe('isCopyResumeOrderCompatible', () => {
	const CURRENT = 1; // stand-in for COPY_ORDER_VERSION

	it('trusts the resume when the cursor order matches the leader (new follower + new leader)', () => {
		expect(isCopyResumeOrderCompatible(1, CURRENT)).to.equal(true);
	});

	it('forces a full recopy for a pre-versioning cursor (copyOrder undefined: old leader or old follower)', () => {
		// both an absent field and an explicit `undefined` decode to undefined at the call site
		expect(isCopyResumeOrderCompatible(undefined, CURRENT)).to.equal(false);
	});

	it('forces a full recopy for a stale/older order version', () => {
		expect(isCopyResumeOrderCompatible(0, CURRENT)).to.equal(false);
		expect(isCopyResumeOrderCompatible(2, CURRENT)).to.equal(false);
	});
});
