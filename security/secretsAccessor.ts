/**
 * Per-component secrets accessor — the interface customer code (components / plugins) uses to read
 * secrets, exposed as `scope.secrets` (and as `import { secrets } from 'harper'`).
 *
 *   const dbUrl = await scope.secrets.get('DATABASE_URL');
 *
 * The accessor is the runtime half of the `secrets:` config declaration (see secretsConfig.ts). The
 * two align by construction, which is the whole security story: the same names the customer writes to
 * *use* a secret are the names Harper uses to *authorize* the read. Three properties fall out of
 * Harper owning the module loader / sandbox boundary:
 *
 *   1. Least authority — a component may read only the secret *names it declared*. Reading anything
 *      else throws. A compromised plugin (or an SSR RCE) can't enumerate or pull secrets it wasn't
 *      granted; and because declared secrets are resolved on demand (never injected into
 *      `process.env`), there's nothing ambient to scrape.
 *   2. Key isolation — resolution (decryption) happens on the trusted side via KeyCustody, which
 *      lives in host scope and is never placed on the component's global or `harper` exports. Customer
 *      code gets *values it was granted*, never the key.
 *   3. Per-component scoping — Harper builds one accessor per component, bound to that component's
 *      declarations. Two components in the same worker isolate can't read each other's secrets.
 *
 * Harper constructs one of these per component with (a) the declarations parsed from its config and
 * (b) a trusted `resolve` bound to that deployment's ciphertext + KeyCustody.
 */
import type { SecretDeclaration } from './secretsConfig.ts';

export interface ComponentSecrets {
	/** Resolve a declared secret's plaintext. Throws if the component didn't declare `name`, or if
	 *  it isn't set for this deployment. */
	get(name: string): Promise<string>;
	/** Whether `name` is declared for this component (does not reveal whether it's set). */
	has(name: string): boolean;
	/** The secret names this component declared. */
	list(): string[];
	/** The full declarations (name/required/description) — for operator tooling like Studio. Never
	 *  includes values. */
	describe(): SecretDeclaration[];
	/** Resolve every `required` declaration, throwing a single error listing any that are unset. Run
	 *  by Harper at component load so a missing/undecryptable required secret fails loud, not at some
	 *  later runtime read. */
	ensureRequired(): Promise<void>;
}

export interface ComponentSecretsOptions {
	/** Component/app name, for clear errors and audit. */
	componentName: string;
	/** Declarations parsed from the component's `secrets:` config (secretsConfig.ts). */
	declarations: SecretDeclaration[];
	/** Trusted resolver: decrypt the named secret via KeyCustody. Returns undefined if not set. */
	resolve: (name: string) => Promise<string | undefined>;
	/** Optional audit hook, invoked on every allowed read (never with the value). */
	onAccess?: (event: { componentName: string; name: string }) => void;
}

export function createComponentSecrets(options: ComponentSecretsOptions): ComponentSecrets {
	const byName = new Map(options.declarations.map((d) => [d.name, d]));
	return {
		has: (name) => byName.has(name),
		list: () => [...byName.keys()],
		describe: () => [...byName.values()],
		async get(name) {
			if (!byName.has(name)) {
				throw new Error(
					`Component "${options.componentName}" is not allowed to read secret "${name}". ` +
						`Declare it under the component's \`secrets\` config to grant access.`
				);
			}
			options.onAccess?.({ componentName: options.componentName, name });
			const value = await options.resolve(name);
			if (value === undefined) {
				throw new Error(`Secret "${name}" is not set for this deployment.`);
			}
			return value;
		},
		async ensureRequired() {
			const missing: string[] = [];
			for (const decl of byName.values()) {
				if (!decl.required) continue;
				options.onAccess?.({ componentName: options.componentName, name: decl.name });
				if ((await options.resolve(decl.name)) === undefined) missing.push(decl.name);
			}
			if (missing.length > 0) {
				throw new Error(
					`Component "${options.componentName}" is missing required secret(s): ${missing.join(', ')}. ` +
						`Set them for this deployment (cluster secrets or the component's .env).`
				);
			}
		},
	};
}
