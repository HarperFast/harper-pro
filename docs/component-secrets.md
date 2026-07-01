# Component secrets (`scope.secrets`)

> Status: prototype / design (Pro). Companion to the core `enc:v1` contract
> (harper `docs/env-secret-encryption.md`) and PR #509.

This describes the **customer-facing configuration** for secrets and why it is, by construction, also
the security boundary. The short version: **the `secrets:` block a component writes to *use* a secret
is the same declaration Harper uses to *authorize* the read.** There is no second ACL to keep in sync.

## Why not just `process.env`?

Harper loads component/plugin code into `node:vm` contexts (hardened with SES / frozen intrinsics)
inside a worker. It builds each context's globals itself — and it copies the host `process` into that
global. So **any component can read `process.env`.** Encrypting a `.env` at rest doesn't change that:
the moment `loadEnv` decrypts and does `process.env[KEY] = value`, the plaintext is ambient and
readable by every component and plugin in the worker (and by an SSR RCE).

`scope.secrets` removes the ambient copy. Secrets are resolved **on demand**, **per component**, and
the plaintext is never written to `process.env`.

## The declaration: `secrets:` in `config.yaml`

A component declares the secrets it consumes, following the same conventions as the rest of
`config.yaml` (cf. `jsResource: { files: ... }`).

**Shorthand** — names only, all required:

```yaml
secrets:
  - DATABASE_URL
  - STRIPE_API_KEY
```

**Object form** — per-secret metadata:

```yaml
secrets:
  DATABASE_URL:
    required: true              # default true; the component fails to load if this is unset
    description: Postgres DSN   # operator-facing hint (e.g. shown in Studio when filling the value)
  DEBUG_WEBHOOK_URL:
    required: false             # optional; guard with scope.secrets.has(...) before get(...)
  STRIPE_API_KEY: true          # sugar for { required: true }
```

## The access: `scope.secrets`

The accessor is bound to the component's scope, and mirrored on the `harper` module:

```js
export async function start(scope) {
  const dbUrl = await scope.secrets.get('DATABASE_URL'); // decrypted plaintext
  if (scope.secrets.has('DEBUG_WEBHOOK_URL')) {
    /* optional */
  }
}
```

```js
import { secrets } from 'harper';
const key = await secrets.get('STRIPE_API_KEY');
```

Surface:

| Method             | Behavior                                                                       |
| ------------------ | ------------------------------------------------------------------------------ |
| `get(name)`        | Declared → decrypted plaintext. Undeclared → throws. Declared but unset → throws. |
| `has(name)`        | Whether `name` is declared (does **not** reveal whether it's set).             |
| `list()`           | The declared names.                                                            |
| `describe()`       | Declarations (`name`/`required`/`description`) for operator tooling. No values.|
| `ensureRequired()` | Resolve every required secret; throw listing any unset. Run by Harper at load. |

## How the declaration *is* the protection

Because Harper owns the module loader, it constructs one accessor per component whose allow-list is
exactly that component's declarations. This yields the properties the design is after, for free:

1. **Least authority.** `get('X')` where `X` wasn't declared throws *before* any resolution — a
   compromised plugin can't enumerate or pull secrets it wasn't granted. No wildcard.
2. **No ambient exposure.** Declared secrets are resolved on demand, never injected into
   `process.env`. Even though `process` is reachable in the sandbox, there's nothing there to scrape.
3. **Key isolation.** Resolution decrypts on the trusted side via KeyCustody, which lives in *host
   scope* — never on the component's global or in the `harper` module. Customer code gets values, not
   the key. (See `keyCustody.ts`.)
4. **Per-component scoping.** Two components in the same worker isolate get different accessors and
   can't read each other's secrets.
5. **Fail loud.** `required` secrets are validated at load via `ensureRequired()`; a missing or
   undecryptable required secret fails the component, rather than surfacing as `undefined` later.

## Where values come from (two tiers)

A declared name resolves from, in precedence order:

1. **Cluster-level secret** (managed / Fabric) — operator-provided, overrides the app default.
2. **Component `.env`** (`enc:v1:` ciphertext) — the inner default layer the app ships/edits.

Both are `enc:v1:` envelopes decrypted on the trusted side. A cluster secret of the same name
overrides the app's `.env` value, so an operator can supply/rotate a production value without editing
the component.

## What this does and doesn't defend against

- **Defends:** a compromised customer plugin, or a JS-level RCE (e.g. Next SSR), reading secrets it
  wasn't granted or scraping `process.env`. This is the multi-tenant threat and the isolate + SES +
  host-scope-key boundary handles it with no extra process.
- **Does not defend (by itself):** host-root or a **native** RCE that reads raw process memory. Those
  require off-box custody (KMS/HSM) or cluster threshold key-shares — an optional higher tier behind
  the same `KeyCustody` interface, out of scope for the customer-code threat above.

## Integration points (not yet wired into core)

- **core loader:** parse `config.secrets` (→ `parseSecretsConfig`), build the accessor
  (`createScopeSecrets`), bind it to `scope.secrets` and the `harper` `secrets` export, and call
  `ensureRequired()` during component load. The accessor attaches to the **per-component** scope, not
  the shared sandbox global or the `harper` module's process-wide singletons.
- **cluster secrets source:** supply the cluster-level `enc:v1:` map to `createScopeSecrets` (Fabric /
  managed tier).
