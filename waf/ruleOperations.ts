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
 * - set_waf_mode    { mode }         — upserts the replicated control row (wave 2, decision b)
 */

import { ClientError } from '../core/utility/errors/hdbError.ts';
import { type WafRule, validateRule } from './rules.ts';

/**
 * Sentinel id of the replicated WAF control row (wave 2). It carries the global mode and is NOT a
 * rule: operators cannot create/alter it via add/alter_waf_rule, it is filtered from list_waf_rules,
 * and the component pulls it out of the rule list before compiling (see waf.ts).
 */
export const WAF_CONTROL_ID = '__waf_control__';

const VALID_MODES = new Set<string>(['enforce', 'monitor', 'off']);

/** The subset of the rule table the operations need (kept narrow for unit-testing). */
export interface WafRuleStore {
	get(id: string): any;
	put(id: string, record: WafRule | { id: string; mode: string }, context?: object): any;
	delete(id: string, context?: object): any;
	primaryStore: { getRange(options: object): Iterable<{ key: unknown; value: any }> };
}

const PATCHABLE_FIELDS = [
	'enabled',
	'priority',
	'phase',
	'description',
	'match',
	'action',
	'score',
	'blockStatus',
	// wave 2 reserved top-level fields (id is never patchable)
	'shadow',
	'activation',
	'scope',
	'provenance',
	'rateLimit',
];

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
			if (String(rule.id) === WAF_CONTROL_ID)
				throw new ClientError(`${WAF_CONTROL_ID} is reserved; use set_waf_mode to control the global mode`);
			// Default provenance for human-authored rules (reserved metadata); keep it light. Build a
			// copy rather than mutating the caller's rule object (input mutation is a foot-gun).
			const stored: WafRule =
				rule.provenance == null
					? { ...rule, provenance: { origin: 'human', approver: request.hdb_user?.username } }
					: rule;
			validateOrThrow(stored);
			if (await table.get(String(stored.id))) {
				throw new ClientError(`WAF rule ${stored.id} already exists; use alter_waf_rule to modify it`, 409);
			}
			// Pass the authenticated user explicitly so the audit record is attributed even if this
			// ships before core's ambient-context fix (harper#1592); explicit context takes precedence
			// over ambient, so this is harmless once #1592 lands and decouples us from its merge order.
			await table.put(String(stored.id), stored, { user: request.hdb_user });
			return { message: `Added WAF rule ${stored.id}` };
		},

		async alterWafRule(request: any) {
			requireSuperUser(request);
			const id = request.id;
			if (id == null) throw new ClientError('alter_waf_rule requires an id');
			if (String(id) === WAF_CONTROL_ID)
				throw new ClientError(`${WAF_CONTROL_ID} is reserved; use set_waf_mode to control the global mode`);
			const existing = await table.get(String(id));
			if (!existing) throw new ClientError(`WAF rule ${id} does not exist`, 404);
			// explicit allowlist: the operations server attaches metadata (hdb_user, transport
			// objects, ...) to the request body, which must not leak into the stored rule
			const updated = { ...existing, id: existing.id } as WafRule;
			for (const field of PATCHABLE_FIELDS) {
				if (field in request) (updated as any)[field] = request[field];
			}
			validateOrThrow(updated);
			await table.put(String(id), updated, { user: request.hdb_user }); // explicit audit user (harper#1592)
			return { message: `Updated WAF rule ${id}` };
		},

		async dropWafRule(request: any) {
			requireSuperUser(request);
			const id = request.id;
			if (id == null) throw new ClientError('drop_waf_rule requires an id');
			if (!(await table.get(String(id)))) throw new ClientError(`WAF rule ${id} does not exist`, 404);
			await table.delete(String(id), { user: request.hdb_user }); // explicit audit user (harper#1592)
			return { message: `Dropped WAF rule ${id}` };
		},

		async listWafRules(request: any) {
			requireSuperUser(request);
			const rules: WafRule[] = [];
			for (const { value } of table.primaryStore.getRange({})) {
				// the control row is not a rule — filter it out of the listing (wave 2)
				if (value && value.id !== WAF_CONTROL_ID) rules.push(value);
			}
			return rules;
		},

		/**
		 * Upserts the replicated control row that carries the global WAF mode (wave 2, decision b):
		 * 'enforce' (normal), 'monitor' (everything runs as shadow), or 'off' (kill switch). The row
		 * replicates cluster-wide like any other table row; each node's component reads it on recompile.
		 */
		async setWafMode(request: any) {
			requireSuperUser(request);
			const mode = request.mode;
			if (!VALID_MODES.has(mode))
				throw new ClientError(`set_waf_mode requires mode to be one of: enforce, monitor, off`);
			await table.put(WAF_CONTROL_ID, { id: WAF_CONTROL_ID, mode }, { user: request.hdb_user });
			return { message: `WAF mode set to ${mode}` };
		},
	};
}
