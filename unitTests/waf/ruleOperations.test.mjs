/**
 * Unit coverage for the dedicated WAF rule operations (waf/ruleOperations.ts).
 *
 * The wire-level authorization (non-super_user roles cannot even reach registered operations)
 * lives in core's operation_authorization; these tests cover the handlers' own defense-in-depth
 * super_user gate plus validation and CRUD behavior against a fake table.
 */

import { expect } from 'chai';
import { makeWafRuleOperations, WAF_CONTROL_ID } from '#src/waf/ruleOperations';

function makeFakeTable() {
	const map = new Map();
	const calls = { put: [], delete: [] };
	return {
		map,
		calls,
		get: (id) => map.get(id),
		put: (id, record, context) => {
			calls.put.push({ id, context });
			map.set(id, record);
		},
		delete: (id, context) => {
			calls.delete.push({ id, context });
			return map.delete(id);
		},
		primaryStore: { getRange: () => Array.from(map, ([key, value]) => ({ key, value })) },
	};
}

const SUPER_USER = { role: { permission: { super_user: true } } };
// full CRUD on the data database, but NOT super_user — must still be rejected
const DATA_ADMIN = {
	role: {
		permission: {
			super_user: false,
			data: { tables: { anything: { read: true, insert: true, update: true, delete: true } } },
		},
	},
};

const RULE = {
	id: 'r1',
	enabled: true,
	priority: 1,
	phase: 'request',
	action: 'block',
	match: { path: { prefix: '/blocked/' } },
};

describe('WAF rule operations', () => {
	it('super_user can add, list, alter, and drop rules', async () => {
		const table = makeFakeTable();
		const operations = makeWafRuleOperations(table);
		await operations.addWafRule({ operation: 'add_waf_rule', hdb_user: SUPER_USER, rule: RULE });
		expect(table.map.get('r1').action).to.equal('block');

		const listed = await operations.listWafRules({ operation: 'list_waf_rules', hdb_user: SUPER_USER });
		expect(listed).to.have.length(1);
		expect(listed[0].id).to.equal('r1');

		await operations.alterWafRule({ operation: 'alter_waf_rule', hdb_user: SUPER_USER, id: 'r1', enabled: false });
		expect(table.map.get('r1').enabled).to.equal(false);
		expect(table.map.get('r1').action).to.equal('block'); // merge keeps unpatched fields

		await operations.dropWafRule({ operation: 'drop_waf_rule', hdb_user: SUPER_USER, id: 'r1' });
		expect(table.map.size).to.equal(0);
	});

	it('threads the authenticated user as explicit write context on put and delete (harper#1592)', async () => {
		const table = makeFakeTable();
		const operations = makeWafRuleOperations(table);
		await operations.addWafRule({ hdb_user: SUPER_USER, rule: RULE });
		await operations.alterWafRule({ hdb_user: SUPER_USER, id: 'r1', enabled: false });
		await operations.dropWafRule({ hdb_user: SUPER_USER, id: 'r1' });

		// add + alter each call put with the request's hdb_user in the context
		expect(table.calls.put).to.have.length(2);
		for (const call of table.calls.put) expect(call.context).to.deep.equal({ user: SUPER_USER });
		// drop calls delete with the same explicit context
		expect(table.calls.delete).to.have.length(1);
		expect(table.calls.delete[0].context).to.deep.equal({ user: SUPER_USER });
	});

	it('rejects non-super_user for every operation, even with full data CRUD permissions', async () => {
		const table = makeFakeTable();
		const operations = makeWafRuleOperations(table);
		const attempts = [
			operations.addWafRule({ hdb_user: DATA_ADMIN, rule: RULE }),
			operations.alterWafRule({ hdb_user: DATA_ADMIN, id: 'r1', enabled: false }),
			operations.dropWafRule({ hdb_user: DATA_ADMIN, id: 'r1' }),
			operations.listWafRules({ hdb_user: DATA_ADMIN }),
			operations.addWafRule({ rule: RULE }), // no user at all
		];
		for (const attempt of attempts) {
			try {
				await attempt;
				expect.fail('expected rejection');
			} catch (error) {
				expect(error.statusCode).to.equal(403);
				expect(error.message).to.include('super_user');
			}
		}
		expect(table.map.size).to.equal(0);
	});

	it('validates rules on add and alter', async () => {
		const table = makeFakeTable();
		const operations = makeWafRuleOperations(table);
		try {
			await operations.addWafRule({ hdb_user: SUPER_USER, rule: { ...RULE, match: {} } });
			expect.fail('expected validation rejection');
		} catch (error) {
			expect(error.statusCode).to.equal(400);
			expect(error.message).to.include('match');
		}
		await operations.addWafRule({ hdb_user: SUPER_USER, rule: RULE });
		try {
			// patching to an invalid action must be rejected and leave the stored rule untouched
			await operations.alterWafRule({ hdb_user: SUPER_USER, id: 'r1', action: 'nuke' });
			expect.fail('expected validation rejection');
		} catch (error) {
			expect(error.statusCode).to.equal(400);
		}
		expect(table.map.get('r1').action).to.equal('block');
	});

	it('defaults provenance to human-authored on add', async () => {
		const table = makeFakeTable();
		const operations = makeWafRuleOperations(table);
		// fresh rule objects — addWafRule assigns the default provenance onto the passed rule
		await operations.addWafRule({ hdb_user: { ...SUPER_USER, username: 'kris' }, rule: { ...RULE } });
		expect(table.map.get('r1').provenance).to.deep.equal({ origin: 'human', approver: 'kris' });
		// an explicit provenance is preserved
		await operations.addWafRule({
			hdb_user: SUPER_USER,
			rule: { ...RULE, id: 'r2', provenance: { origin: 'managed-feed', source: 'feed' } },
		});
		expect(table.map.get('r2').provenance).to.deep.equal({ origin: 'managed-feed', source: 'feed' });
	});

	it('patches the wave-2 reserved top-level fields on alter', async () => {
		const table = makeFakeTable();
		const operations = makeWafRuleOperations(table);
		await operations.addWafRule({ hdb_user: SUPER_USER, rule: RULE });
		await operations.alterWafRule({
			hdb_user: SUPER_USER,
			id: 'r1',
			shadow: true,
			activation: { nodes: ['n1'] },
			scope: { tenants: ['t'] },
			rateLimit: { key: ['ip'], limit: 5 },
		});
		const stored = table.map.get('r1');
		expect(stored.shadow).to.equal(true);
		expect(stored.activation).to.deep.equal({ nodes: ['n1'] });
		expect(stored.scope).to.deep.equal({ tenants: ['t'] });
		expect(stored.rateLimit).to.deep.equal({ key: ['ip'], limit: 5 });
	});

	describe('set_waf_mode + control-row sentinel guards', () => {
		it('set_waf_mode upserts the control row (super_user only, validated)', async () => {
			const table = makeFakeTable();
			const operations = makeWafRuleOperations(table);
			await operations.setWafMode({ hdb_user: SUPER_USER, mode: 'monitor' });
			expect(table.map.get(WAF_CONTROL_ID)).to.deep.equal({ id: WAF_CONTROL_ID, mode: 'monitor' });
			// upsert (not duplicate-rejected)
			await operations.setWafMode({ hdb_user: SUPER_USER, mode: 'off' });
			expect(table.map.get(WAF_CONTROL_ID).mode).to.equal('off');
			expect(table.calls.put.every((c) => c.context.user === SUPER_USER)).to.equal(true);
		});

		it('set_waf_mode rejects an invalid mode and non-super_user', async () => {
			const table = makeFakeTable();
			const operations = makeWafRuleOperations(table);
			try {
				await operations.setWafMode({ hdb_user: SUPER_USER, mode: 'paranoid' });
				expect.fail('expected rejection');
			} catch (error) {
				expect(error.statusCode).to.equal(400);
			}
			try {
				await operations.setWafMode({ hdb_user: DATA_ADMIN, mode: 'off' });
				expect.fail('expected rejection');
			} catch (error) {
				expect(error.statusCode).to.equal(403);
			}
			expect(table.map.size).to.equal(0);
		});

		it('add/alter reject the reserved control-row id', async () => {
			const table = makeFakeTable();
			const operations = makeWafRuleOperations(table);
			try {
				await operations.addWafRule({ hdb_user: SUPER_USER, rule: { ...RULE, id: WAF_CONTROL_ID } });
				expect.fail('expected rejection');
			} catch (error) {
				expect(error.message).to.include('reserved');
			}
			try {
				await operations.alterWafRule({ hdb_user: SUPER_USER, id: WAF_CONTROL_ID, enabled: false });
				expect.fail('expected rejection');
			} catch (error) {
				expect(error.message).to.include('reserved');
			}
			expect(table.map.has(WAF_CONTROL_ID)).to.equal(false);
		});

		it('list_waf_rules excludes the control row', async () => {
			const table = makeFakeTable();
			const operations = makeWafRuleOperations(table);
			await operations.addWafRule({ hdb_user: SUPER_USER, rule: RULE });
			await operations.setWafMode({ hdb_user: SUPER_USER, mode: 'enforce' });
			const listed = await operations.listWafRules({ hdb_user: SUPER_USER });
			expect(listed).to.have.length(1);
			expect(listed[0].id).to.equal('r1');
		});
	});

	it('rejects duplicate adds and missing-id alters/drops', async () => {
		const table = makeFakeTable();
		const operations = makeWafRuleOperations(table);
		await operations.addWafRule({ hdb_user: SUPER_USER, rule: RULE });
		try {
			await operations.addWafRule({ hdb_user: SUPER_USER, rule: RULE });
			expect.fail('expected duplicate rejection');
		} catch (error) {
			expect(error.statusCode).to.equal(409);
		}
		try {
			await operations.alterWafRule({ hdb_user: SUPER_USER, id: 'missing', enabled: false });
			expect.fail('expected missing-rule rejection');
		} catch (error) {
			expect(error.statusCode).to.equal(404);
		}
		try {
			await operations.dropWafRule({ hdb_user: SUPER_USER, id: 'missing' });
			expect.fail('expected missing-rule rejection');
		} catch (error) {
			expect(error.statusCode).to.equal(404);
		}
	});
});
