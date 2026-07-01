# Component secrets (`scope.secrets`)

> Status: prototype / design (Pro). Companion to the core `enc:v1` contract
> (harper `docs/env-secret-encryption.md`) and PR #509.

Secrets for components, where **authority lives in a trusted store Harper controls — never in a
component's own config.** A component can *state what it needs*, but only an operator can *grant it*,
and Harper checks the grant using an identity it asserts about the component.

## Why not per-component config, and why not `process.env`?

- **Config can't be the authority.** A component (and whoever writes/deploys its config) controls its
  own `config.yaml`. If that file decided access, a component would authorize itself — no control at
  all. So the allow-list must live somewhere the component can't write.
- **`process.env` is ambient.** Harper loads component/plugin code into `node:vm` contexts (hardened
  with SES / frozen intrinsics) and copies the host `process` into their globals — so any component
  can read `process.env`. Encrypting a `.env` at rest doesn't help once `loadEnv` writes the decrypted
  value there. `scope.secrets` resolves on demand and never populates `process.env`.

## The authority: `system.hdb_secret` (trusted, replicated)

A table in Harper's `system` database — the same replicated store behind `hdb_user` / `hdb_role`, so
grants and encrypted values are consistent cluster-wide and available even when an instance is down.
Writable only by super_user (operators).

| field         | meaning                                                          |
| ------------- | ---------------------------------------------------------------- |
| `name` (PK)   | cluster-wide secret name                                         |
| `value`       | `enc:v1:` ciphertext (decryptable only by the host-scope key)    |
| `grants`      | component identities authorized to read it — **the authority**   |
| metadata      | `description`, `updatedBy`, `updatedAt`                           |

Operator operations (super_user), values in/out as ciphertext only — plaintext never passes through
the server:

- `set_secret {name, value?, grants?, description?}` — upsert a secret's ciphertext / grants.
- `grant_secret {name, component}` / `revoke_secret {name, component}` — manage the allow-list.
- `list_secrets` — names, grants, metadata; **never values**.

## The identity: asserted by Harper, not the component

Grants key off the component name Harper's loader stamps
(`new ApplicationScope(basename(componentDirectory), …)`), so a component cannot claim to be another.
The accessor's identity is fixed at construction by Harper. Trust in the name is only as strong as
**who can deploy a component under that name** — operator-controlled in managed/Fabric; a deploy-time
assumption on self-hosted.

## Resolution

`scope.secrets.get('X')` from component **C**:

1. Look up `X` in `system.hdb_secret`.
2. Allow only if `C ∈ X.grants` — else throw (the error points at `grant_secret`; a component can't
   grant itself).
3. Decrypt `X.value` on the trusted side via KeyCustody (host scope) and return the plaintext.

Nothing is written to `process.env`; the key never enters the component sandbox; and C can't read a
secret granted only to another component.

## The manifest: what a component *declares it needs* (non-authoritative)

A component may list the secrets it consumes in its `config.yaml`. This is a **request**, not a grant:

```yaml
secrets:
  DATABASE_URL:
    required: true              # fail the component at load if not granted+set
    description: Postgres DSN   # shown to operators so they know what to grant
  DEBUG_WEBHOOK_URL:
    required: false
# or shorthand — names only, all required:
secrets:
  - DATABASE_URL
  - STRIPE_API_KEY
```

Harper uses the manifest only to (a) fail loud at load via `ensureRequired()` (distinguishing *not
granted* from *granted but unset*) and (b) tell operators what to grant. It can never widen access
beyond the store's grants.

## Access

```js
export async function start(scope) {
  const dbUrl = await scope.secrets.get('DATABASE_URL'); // decrypted; never in process.env
  if (await scope.secrets.has('DEBUG_WEBHOOK_URL')) {
    /* granted? */
  }
}
// also: import { secrets } from 'harper'
```

| Method             | Behavior                                                                          |
| ------------------ | --------------------------------------------------------------------------------- |
| `get(name)`        | Granted → decrypted plaintext. Not granted → throws. Granted but unset → throws.  |
| `has(name)`        | Whether this component is granted `name` (authoritative — from the store).        |
| `list()`           | The names granted to this component (authoritative).                              |
| `describe()`       | The component's declared manifest (non-authoritative). No values.                 |
| `ensureRequired()` | Resolve required manifest entries; throw listing any not-granted / granted-unset. |

## What this defends — and what it doesn't

- **Defends:** a compromised plugin or a JS-level RCE (e.g. Next SSR) reading secrets it wasn't
  granted, scraping `process.env`, or self-granting via its own config. The isolate + SES + host-scope
  key + trusted-store grants handle this with no extra process.
- **Does not (by itself):** host-root or a **native** RCE reading raw process memory; or a hostile
  deploy that names itself as a granted component. The first needs off-box custody (KMS/HSM) or
  cluster threshold key-shares (optional tiers behind the same `KeyCustody` interface); the second is
  a deploy-time trust question.

## Integration points (not yet wired into core)

- **`system.hdb_secret` table:** declare it in core like `hdb_user`/`hdb_role` (super_user-writable,
  replicated). `TableSecretsStore` in `secretsStore.ts` is the sketch that binds to it; tests use
  `InMemorySecretsStore`.
- **Operator operations:** register `set_secret` / `grant_secret` / `revoke_secret` / `list_secrets`
  (the handlers delegate to the store functions in `secretsStore.ts`).
- **core loader:** build the accessor with the loader-asserted `componentName` + the shared store,
  bind it to the per-component `scope.secrets` (and the `harper` `secrets` export — never the shared
  global), pass the parsed manifest, and call `ensureRequired()` at load.
