/**
 * Dedicated operations-API operations for managing WAF rules.
 *
 * Rules live in `system.hdb_waf_rules`, and core's operation authorization forbids generic CRUD
 * operations on system tables (only hdb_nodes/hdb_role/hdb_user are allowlisted for super_user).
 * The supported pattern for component-owned system tables is dedicated registered operations —
 * the same shape as replication's add_node / licensing's install_usage_license: registered via
 * `server.registerOperation` on the main thread, reachable by super_user (registered operations
 * without table targets pass the generic super_user bypass) and unreachable by other roles (the
 * operation is not in the permissions map, so authorization rejects it). `requireSuperUser` is
 * defense-in-depth on top of that.
 *
 * Operations (all JSON bodies):
 * - add_waf_rule    { rule }         — validates and inserts a new rule
 * - alter_waf_rule  { id, ...patch } — merges the patch into an existing rule and re-validates
 * - drop_waf_rule   { id }
 * - list_waf_rules  {}
 */

import { ClientError } from '../core/utility/errors/hdbError.ts';
import { type WafRule, validateRule } from './rules.ts';

/** The subset of the rule table the operations need (kept narrow for unit-testing). */
export interface WafRuleStore {
	get(id: string): any;
	put(id: string, record: WafRule): any;
	delete(id: string): any;
	primaryStore: { getRange(options: object): Iterable<{ key: unknown; value: any }> };
}

const PATCHABLE_FIELDS = ['enabled', 'priority', 'phase', 'description', 'match', 'action', 'score', 'blockStatus'];

function requireSuperUser(request: any) {
	if (!request?.hdb_user?.role?.permission?.super_user) {
		throw new ClientError('This operation is restricted to super_user roles', 403);
	}
}

function validateOrThrow(rule: WafRule) {
	const problems = validateRule(rule);
	if (problems.length > 0) {
		throw new ClientError(`Invalid WAF rule: ${problems.join('; ')}`);
	}
}

export function makeWafRuleOperations(table: WafRuleStore) {
	return {
		async addWafRule(request: any) {
			requireSuperUser(request);
			const rule = request.rule as WafRule;
			if (!rule || typeof rule !== 'object') throw new ClientError('add_waf_rule requires a rule object');
			if (rule.id == null) throw new ClientError('add_waf_rule requires rule.id');
			validateOrThrow(rule);
			if (await table.get(String(rule.id))) {
				throw new ClientError(`WAF rule ${rule.id} already exists; use alter_waf_rule to modify it`, 409);
			}
			await table.put(String(rule.id), rule);
			return { message: `Added WAF rule ${rule.id}` };
		},

		async alterWafRule(request: any) {
			requireSuperUser(request);
			const id = request.id;
			if (id == null) throw new ClientError('alter_waf_rule requires an id');
			const existing = await table.get(String(id));
			if (!existing) throw new ClientError(`WAF rule ${id} does not exist`, 404);
			// explicit allowlist: the operations server attaches metadata (hdb_user, transport
			// objects, ...) to the request body, which must not leak into the stored rule
			const updated = { ...existing, id: existing.id } as WafRule;
			for (const field of PATCHABLE_FIELDS) {
				if (field in request) (updated as any)[field] = request[field];
			}
			validateOrThrow(updated);
			await table.put(String(id), updated);
			return { message: `Updated WAF rule ${id}` };
		},

		async dropWafRule(request: any) {
			requireSuperUser(request);
			const id = request.id;
			if (id == null) throw new ClientError('drop_waf_rule requires an id');
			if (!(await table.get(String(id)))) throw new ClientError(`WAF rule ${id} does not exist`, 404);
			await table.delete(String(id));
			return { message: `Dropped WAF rule ${id}` };
		},

		async listWafRules(request: any) {
			requireSuperUser(request);
			const rules: WafRule[] = [];
			for (const { value } of table.primaryStore.getRange({})) {
				if (value) rules.push(value);
			}
			return rules;
		},
	};
}
