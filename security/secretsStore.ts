/**
 * The trusted secrets store — the AUTHORITY for env-secrets. This is the piece that fixes the
 * self-granting hole: a secret's grant list (which components may read it) lives here, in a store
 * only operators can write, NOT in a component's own config (which the component controls). A
 * compromised component can rewrite its `config.yaml` all it likes; it cannot add itself to a
 * secret's `grants` here.
 *
 * Shape mirrors what Harper already does for `hdb_user` / `hdb_role`: a table in the replicated
 * `system` database, so grants + encrypted values are consistent across the cluster and available
 * even when a given instance is down. Production binds to `getDatabases().system.hdb_secret`
 * (see TableSecretsStore); InMemorySecretsStore backs tests and local prototyping.
 *
 * Records hold only `enc:v1:` CIPHERTEXT — the store never sees plaintext, and values are decrypted
 * on demand, on the trusted side, via KeyCustody (see keyCustody.ts). `value` is decrypted only for a
 * component the record's `grants` authorize (enforced by the per-component accessor, secretsAccessor.ts).
 */

export interface SecretRecord {
	/** Cluster-wide secret name (primary key). */
	name: string;
	/** `enc:v1:` ciphertext. Undefined if a record exists (e.g. grants set) but no value yet. */
	value?: string;
	/** Component identities authorized to read this secret — the authority. */
	grants: string[];
	/** Operator-facing description; never a value. */
	description?: string;
	/** Audit: who last wrote it, and when (ms epoch, stamped by the caller). */
	updatedBy?: string;
	updatedAt?: number;
}

/** Public view of a secret — everything EXCEPT the ciphertext. Safe to return from `list_secrets`. */
export interface SecretInfo {
	name: string;
	grants: string[];
	description?: string;
	hasValue: boolean;
	updatedBy?: string;
	updatedAt?: number;
}

/**
 * The trusted store. `get` is the hot path (per read); `list`/`put`/`delete` back the operator
 * operations. Implementations must be backed by an operator-only, replicated store.
 */
export interface SecretsStore {
	get(name: string): Promise<SecretRecord | undefined>;
	list(): Promise<SecretRecord[]>;
	put(record: SecretRecord): Promise<void>;
	delete(name: string): Promise<void>;
}

/** Authority check: may `component` read this record? The single place the grant decision is made. */
export function isGranted(record: SecretRecord | undefined, component: string): boolean {
	return record !== undefined && record.grants.includes(component);
}

function toInfo(record: SecretRecord): SecretInfo {
	return {
		name: record.name,
		grants: [...record.grants],
		description: record.description,
		hasValue: record.value !== undefined,
		updatedBy: record.updatedBy,
		updatedAt: record.updatedAt,
	};
}

// ---- Operator operations (super_user) — the write surface, delegating to a SecretsStore. ----
// These back the `set_secret` / `grant_secret` / `revoke_secret` / `list_secrets` operations. They
// take/return only ciphertext + metadata; plaintext never passes through the server.

export interface SetSecretInput {
	name: string;
	/** `enc:v1:` ciphertext (client-encrypted against the instance public key). Optional: an operator
	 *  may create/adjust grants before supplying a value. */
	value?: string;
	/** Replace the grant list. Omit to leave existing grants unchanged. */
	grants?: string[];
	description?: string;
	actor?: string;
	now?: number;
}

/** Upsert a secret's ciphertext / grants / description. */
export async function setSecret(store: SecretsStore, input: SetSecretInput): Promise<SecretInfo> {
	const existing = await store.get(input.name);
	const record: SecretRecord = {
		name: input.name,
		value: input.value !== undefined ? input.value : existing?.value,
		grants: input.grants !== undefined ? [...new Set(input.grants)] : (existing?.grants ?? []),
		description: input.description !== undefined ? input.description : existing?.description,
		updatedBy: input.actor,
		updatedAt: input.now,
	};
	await store.put(record);
	return toInfo(record);
}

/** Add a component to a secret's grant list. */
export async function grantSecret(
	store: SecretsStore,
	input: { name: string; component: string; actor?: string; now?: number }
): Promise<SecretInfo> {
	const existing = await store.get(input.name);
	if (!existing) throw new Error(`Secret "${input.name}" does not exist.`);
	const grants = new Set(existing.grants);
	grants.add(input.component);
	const record: SecretRecord = { ...existing, grants: [...grants], updatedBy: input.actor, updatedAt: input.now };
	await store.put(record);
	return toInfo(record);
}

/** Remove a component from a secret's grant list. */
export async function revokeSecret(
	store: SecretsStore,
	input: { name: string; component: string; actor?: string; now?: number }
): Promise<SecretInfo> {
	const existing = await store.get(input.name);
	if (!existing) throw new Error(`Secret "${input.name}" does not exist.`);
	const record: SecretRecord = {
		...existing,
		grants: existing.grants.filter((c) => c !== input.component),
		updatedBy: input.actor,
		updatedAt: input.now,
	};
	await store.put(record);
	return toInfo(record);
}

/** List all secrets as public info (names, grants, metadata) — never values. */
export async function listSecrets(store: SecretsStore): Promise<SecretInfo[]> {
	return (await store.list()).map(toInfo);
}

/** In-memory store for tests / local prototyping. NOT for production (not replicated, not persisted). */
export class InMemorySecretsStore implements SecretsStore {
	readonly #records = new Map<string, SecretRecord>();

	async get(name: string): Promise<SecretRecord | undefined> {
		const r = this.#records.get(name);
		return r ? { ...r, grants: [...r.grants] } : undefined;
	}
	async list(): Promise<SecretRecord[]> {
		return [...this.#records.values()].map((r) => ({ ...r, grants: [...r.grants] }));
	}
	async put(record: SecretRecord): Promise<void> {
		this.#records.set(record.name, { ...record, grants: [...record.grants] });
	}
	async delete(name: string): Promise<void> {
		this.#records.delete(name);
	}
}

/**
 * Production store (sketch): binds to the replicated `system.hdb_secret` table. The table itself must
 * be declared in core (like `hdb_user`/`hdb_role`), writable only by super_user, and replicated via
 * the system database. The method bodies below are indicative — verify the exact calls against core's
 * Table/Resource API before relying on them. This is the one piece that requires core wiring.
 */
export class TableSecretsStore implements SecretsStore {
	// The core `system.hdb_secret` table resource (from `getDatabases().system.hdb_secret`).
	readonly #table: any;
	constructor(table: unknown) {
		this.#table = table;
	}
	async get(name: string): Promise<SecretRecord | undefined> {
		return (await this.#table.get(name)) ?? undefined;
	}
	async list(): Promise<SecretRecord[]> {
		const out: SecretRecord[] = [];
		for await (const record of this.#table.search({})) out.push(record);
		return out;
	}
	async put(record: SecretRecord): Promise<void> {
		await this.#table.put(record);
	}
	async delete(name: string): Promise<void> {
		await this.#table.delete(name);
	}
}
