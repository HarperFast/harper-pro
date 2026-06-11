# acl-connect fixture

A minimal deployable wrapper around the public `@harperdb/acl-connect` extension
(`HarperFast/acl-connect`), used by `smokeTests/components/acl-connect.smoke.mjs` and
`stressTests/components/acl-connect.stress.mjs`.

The library itself only defines the extension hooks; it has no ACL topology, no JWT
mapping, and is not directly deployable. This fixture supplies the missing pieces:

- `connect.json` — the `dog/#` topic ACL with `dogPublisher` / `dogSubscriber` groups
- `resources.js` + `utility.js` — `server.getUser` and `server.mqtt.authorizeClient`
  overrides that decode JWT passwords (via `jsonwebtoken`) and enforce the clientId claim
- `config.yaml` — wires the above and references `@harperdb/acl-connect` as a sub-component
- `package.json` — pulls `@harperdb/acl-connect` straight from `github:HarperFast/acl-connect#main`

Adapted from the (private) `HarperFast/acl-connect-example` so the smoke suite can run
against only public sources.
