/**
 * Per-component secrets accessor — the interface customer code (components / plugins) uses to read
 * secrets, exposed as `scope.secrets` (and as `import { secrets } from 'harper'`).
 *
 *   const dbUrl = await scope.secrets.get('DATABASE_URL');
 *
 * Authority comes from the TRUSTED STORE (secretsStore.ts), never from the component. Harper builds
 * one accessor per component, bound to a `componentName` that Harper itself asserts (the loader stamps
 * it — `new ApplicationScope(basename(componentDirectory), …)`), so the component can't spoof its own
 * identity. A read is allowed only if the secret's `grants` in the store include this component. Three
 * properties fall out of Harper owning the loader + holding the store:
 *
 *   1. Least authority, not self-granted — a component reads a secret only if an operator granted it
 *      in the store. Editing its own config grants nothing. Undeclared/ungranted reads throw before
 *      any decryption, and nothing lands in `process.env`, so there's nothing ambient to scrape.
 *   2. Key isolation — resolution decrypts on the trusted side via KeyCustody (host scope); customer
 *      code gets values it was granted, never the key and never other components' secrets.
 *   3. Per-component scoping — the accessor's identity is fixed at construction by Harper; two
 *      components in the same worker isolate get different, independently-scoped accessors.
 *
 * The optional `manifest` (the component's `secrets:` config, secretsConfig.ts) is NON-AUTHORITATIVE:
 * it's the component's stated *needs*, used only for load-time fail-fast (`ensureRequired`) and
 * operator tooling (`describe`). It can never widen what the grants allow.
 */
import { isGranted, type SecretsStore } from './secretsStore.ts';
import type { SecretDeclaration } from './secretsConfig.ts';

export interface ComponentSecrets {
	/** Resolve a granted secret's plaintext. Throws if this component isn't granted `name`, or the
	 *  secret has no value set. */
	get(name: string): Promise<string>;
	/** Whether this component is granted `name` (authoritative — from the store). */
	has(name: string): Promise<boolean>;
	/** The secret names this component is granted (authoritative — from the store). */
	list(): Promise<string[]>;
	/** The component's declared manifest (name/required/description) — non-authoritative, for tooling.
	 *  Never includes values. */
	describe(): SecretDeclaration[];
	/** Resolve every `required` manifest entry, throwing a single error listing any that are unset —
	 *  distinguishing "not granted" from "granted but no value". Run by Harper at component load so a
	 *  missing required secret fails loud, not at some later read. */
	ensureRequired(): Promise<void>;
}

export interface ComponentSecretsOptions {
	/** Component identity — asserted by Harper's loader, not by the component. */
	componentName: string;
	/** The trusted authority: grant checks + ciphertext. */
	store: SecretsStore;
	/** Decrypt an `enc:v1:` ciphertext on the trusted side (via KeyCustody). */
	decrypt: (ciphertext: string) => Promise<string>;
	/** The component's non-authoritative declared needs (from its `secrets:` config). */
	manifest?: SecretDeclaration[];
	/** Optional audit hook, invoked on every allowed read (never with the value). */
	onAccess?: (event: { componentName: string; name: string }) => void;
}

export function createComponentSecrets(options: ComponentSecretsOptions): ComponentSecrets {
	const { componentName, store, decrypt, manifest = [] } = options;

	return {
		async has(name) {
			return isGranted(await store.get(name), componentName);
		},
		async list() {
			return (await store.list()).filter((r) => r.grants.includes(componentName)).map((r) => r.name);
		},
		describe: () => [...manifest],
		async get(name) {
			const record = await store.get(name);
			if (!isGranted(record, componentName)) {
				throw new Error(
					`Component "${componentName}" is not granted secret "${name}". ` +
						`An operator must grant it in the secrets store (grant_secret) — a component cannot grant itself.`
				);
			}
			if (record!.value === undefined) {
				throw new Error(`Secret "${name}" is granted but has no value set for this deployment.`);
			}
			options.onAccess?.({ componentName, name });
			return decrypt(record!.value);
		},
		async ensureRequired() {
			const ungranted: string[] = [];
			const valueless: string[] = [];
			for (const decl of manifest) {
				if (!decl.required) continue;
				const record = await store.get(decl.name);
				if (!isGranted(record, componentName)) ungranted.push(decl.name);
				else if (record!.value === undefined) valueless.push(decl.name);
			}
			if (ungranted.length === 0 && valueless.length === 0) return;
			const parts: string[] = [];
			if (ungranted.length > 0) parts.push(`not granted: ${ungranted.join(', ')}`);
			if (valueless.length > 0) parts.push(`granted but unset: ${valueless.join(', ')}`);
			throw new Error(`Component "${componentName}" is missing required secret(s) — ${parts.join('; ')}.`);
		},
	};
}
