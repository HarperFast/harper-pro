/**
 * Per-component secrets accessor — the interface customer code (components / plugins) uses to read
 * secrets, exposed as `scope.secrets`.
 *
 *   const dbUrl = await scope.secrets.get('DATABASE_URL');
 *
 * Two properties come from Harper owning the sandbox boundary:
 *
 *   1. Least authority — a component may only read the secret *names it declared* (in its config).
 *      Reading anything else throws. So a compromised plugin (or an SSR RCE) can't enumerate or pull
 *      secrets it wasn't granted; and unlike ambient `process.env`, there's nothing to scrape.
 *   2. Key isolation — resolution (decryption) happens on the trusted side via KeyCustody; the
 *      private key never crosses into sandboxed code. Customer code gets *values it was granted*,
 *      never the key.
 *
 * Harper is responsible for constructing one of these per component with (a) the component's declared
 * keys and (b) a trusted `resolve` bound to that deployment's ciphertext + KeyCustody.
 */

export interface ComponentSecrets {
	/** Resolve a declared secret's plaintext. Throws if the component didn't declare `name`, or if
	 *  it isn't set for this deployment. */
	get(name: string): Promise<string>;
	/** Whether `name` is declared for this component (does not reveal whether it's set). */
	has(name: string): boolean;
	/** The secret names this component declared. */
	list(): string[];
}

export interface ComponentSecretsOptions {
	/** Component/app name, for clear errors and audit. */
	componentName: string;
	/** Secret names this component declared it needs (from its config). */
	declaredKeys: string[];
	/** Trusted resolver: decrypt the named secret via KeyCustody. Returns undefined if not set. */
	resolve: (name: string) => Promise<string | undefined>;
	/** Optional audit hook, invoked on every allowed read (never with the value). */
	onAccess?: (event: { componentName: string; name: string }) => void;
}

export function createComponentSecrets(options: ComponentSecretsOptions): ComponentSecrets {
	const declared = new Set(options.declaredKeys);
	return {
		has: (name) => declared.has(name),
		list: () => [...declared],
		async get(name) {
			if (!declared.has(name)) {
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
	};
}
