/**
 * The component's secrets MANIFEST — the `secrets:` block in its `config.yaml`. This is where a
 * component states which secrets it *needs*.
 *
 * IMPORTANT: this is NON-AUTHORITATIVE. The component (and whoever writes/deploys its config)
 * controls this file, so it cannot be the thing that grants access — otherwise a component would
 * authorize itself. Authority lives in the trusted, operator-only secrets store (secretsStore.ts):
 * a read is allowed only if that store's `grants` for the secret include this component. The manifest
 * is used only to (a) fail loud at load if a required secret isn't granted/set (`ensureRequired`) and
 * (b) tell operators what a component wants so they can grant it. It can never widen access.
 *
 * Two forms, both following existing config.yaml conventions (cf. `jsResource: { files: ... }`):
 *
 *   # shorthand — names only, all required
 *   secrets:
 *     - DATABASE_URL
 *     - STRIPE_API_KEY
 *
 *   # object form — per-secret metadata
 *   secrets:
 *     DATABASE_URL:
 *       required: true              # default true; component fails to load if unset (fail loud)
 *       description: Postgres DSN   # shown to operators in Studio when filling the value
 *     DEBUG_WEBHOOK_URL:
 *       required: false             # optional; guard with scope.secrets.has(...) before get(...)
 *
 * A bare `true` value (`DATABASE_URL: true`) is accepted as sugar for `{ required: true }`.
 */

export interface SecretDeclaration {
	/** The name the component reads via `scope.secrets.get(name)`, and the allow-list entry. */
	name: string;
	/** If true (default), the component fails to load when this secret is unset for the deployment. */
	required: boolean;
	/** Operator-facing hint surfaced when filling the value (e.g. in Studio). Never a value. */
	description?: string;
}

// Conservative env-var-style name: letters/underscore start, then letters/digits/_/./-. Keeps the
// declared names compatible with `.env` keys and safe to echo in errors/audit logs.
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function assertName(name: string): void {
	if (!SECRET_NAME.test(name)) {
		throw new Error(
			`Invalid secret name "${name}" — use letters, digits, underscore, dot, or dash (must start with a letter or underscore).`
		);
	}
}

/**
 * Parse the `secrets:` block of a component config into normalized declarations. Missing/empty →
 * no declarations (the component gets an accessor that denies everything). Later duplicates win.
 */
export function parseSecretsConfig(componentConfig: unknown): SecretDeclaration[] {
	const raw = (componentConfig as { secrets?: unknown } | null | undefined)?.secrets;
	if (raw == null) return [];

	const byName = new Map<string, SecretDeclaration>();
	const add = (name: string, decl: Omit<SecretDeclaration, 'name'>) => {
		assertName(name);
		byName.set(name, { name, ...decl });
	};

	if (Array.isArray(raw)) {
		for (const entry of raw) {
			if (typeof entry !== 'string') {
				throw new Error('Each entry of a `secrets:` list must be a string secret name.');
			}
			add(entry, { required: true });
		}
		return [...byName.values()];
	}

	if (typeof raw === 'object') {
		for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
			if (value === true || value == null) {
				add(name, { required: true });
			} else if (typeof value === 'object') {
				const v = value as { required?: unknown; description?: unknown };
				add(name, {
					required: v.required === undefined ? true : Boolean(v.required),
					description: typeof v.description === 'string' ? v.description : undefined,
				});
			} else {
				throw new Error(`Secret "${name}" must map to \`true\` or an object with \`required\`/\`description\`.`);
			}
		}
		return [...byName.values()];
	}

	throw new Error('`secrets:` must be a list of names or a map of name → options.');
}
