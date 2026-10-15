# cloneNode design notes

## A clone copies filesystem-only applications as the leader packaged them

**Invariant.** A clone marked `cloned` and `Available` holds every filesystem-only application of its
leader — one without a config `package`, so nothing reinstalls it on start. An application it could not
copy stops clone setup: the node stays running, Unavailable and uncloned, and the next start replays setup.
A dot-prefixed directory (`.git`) is not an application: the loader never loads one and
`package_component` refuses its name, so the clone skips it. Any other name outside `PROJECT_NAME_PATTERN`
stops setup without a request: `package_component` would refuse it, or cut `app.v2` to `app` and return a
different application.

**`node_modules` only from a leader that can send it cheaply.** Over HTTP from a leader on 5.3.0 or later,
the clone requests each application with its `node_modules` and streams it. Rebuilding with `npm install`
loses whatever npm cannot reproduce: a `file:` dependency into `node_modules`, a bundler's private
workspace packages, and a payload deploy's request-scoped install options and registry credentials
(harper-pro#1047). Anywhere else the clone asks for the application without `node_modules` and npm
rebuilds it, logging that packages existing only there will be missing. Earlier leaders follow the
loader's link to their own install (`node_modules/harper`, or `node_modules/harperdb` on v4), so every
application would carry the whole install — measured at 80 MB of base64 for a two-file app on a v4.7
leader. Cert auth gets one buffered message over the replication socket, which cannot stream.

**Where.** `applicationClone.ts` (`cloneFilesystemOnlyApplications`, `packagesNodeModulesWithoutInstall`);
`cloneNode.ts` `chooseTransfer` and `leaderVersion` (`registration_info`); `leaderHTTP.ts` streams the
archive. Tests: `unitTests/cloneNode/applicationClone.test.mjs`, `integrationTests/cloneNode/cloneNode.test.mjs`,
`integrationTests/cluster/cloneFromLegacy.test.mjs`.

**Limits.** The copy is core's package of the leader's tree: links dereferenced, core's exclusions
applied. Until HarperFast/harper#3207 ships, the leader still packs its install through the loader link
inside every npm sub-component; the clone's loader replaces each copy with its own link. Copying assumes
leader and clone share a platform, as any payload deploy that carries `node_modules` already does. Success
means the application was prepared, not that its workers loaded it.
