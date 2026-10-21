# cloneNode design notes

## A clone copies filesystem-only applications as the leader packaged them

**Invariant.** A clone marked `cloned` and `Available` holds every filesystem-only application of its
leader — one without a config `package`, so nothing reinstalls it on start. An application it could not
copy stops clone setup: the node stays running, Unavailable and uncloned, and the next start replays setup.
A dot-prefixed directory (`.git`) is not an application: the loader never loads one and
`package_component` refuses its name, so the clone skips it. Any other name outside `PROJECT_NAME_PATTERN`
stops setup without a request: `package_component` would refuse it, or cut `app.v2` to `app` and return a
different application.

**`node_modules` only from a leader that streams it.** Over HTTP from a leader on 5.2.3 or later, the
clone requests each application with its `node_modules` and streams it, so the leader holds no
archive-sized buffer. Rebuilding with `npm install` loses whatever npm cannot reproduce: a `file:`
dependency into `node_modules`, a bundler's private workspace packages, and a payload deploy's
request-scoped install options and registry credentials (harper-pro#1047). A leader that cannot stream —
v4, v5 before 5.2.3, or any leader under cert auth, whose replication socket carries one buffered message —
gets the request without `node_modules` and npm rebuilds it, with a log line saying packages that exist only
there will be missing. Buffering `node_modules` would cost the serving leader about 4.7× the archive, and
before 5.3.0 the archive also carries the leader's own install through the loader's link
(`node_modules/harper`, or `node_modules/harperdb` on v4): 80 MB of base64 for a two-file app on a v4.7
leader. From 5.2.3 to 5.2.x that install still streams with each application; the clone's loader replaces
it with its own link. A leader whose version the clone cannot read stops the clone (retryable) rather than
risk the rebuild.

**Where.** `applicationClone.ts` (`cloneFilesystemOnlyApplications`, `streamsPackages`);
`cloneNode.ts` `chooseTransfer` and `leaderVersion` (`registration_info`); `leaderHTTP.ts` streams the
archive. Tests: `unitTests/cloneNode/applicationClone.test.mjs`, `integrationTests/cloneNode/cloneNode.test.mjs`,
`integrationTests/cluster/cloneFromLegacy.test.mjs`.

**Limits.** The copy is core's package of the leader's tree: links dereferenced, core's exclusions
applied. Until HarperFast/harper#3207 ships, the leader still packs its install through the loader link
inside every npm sub-component; the clone's loader replaces each copy with its own link. Copying assumes
leader and clone share a platform, as any payload deploy that carries `node_modules` already does. Over a
buffered transfer, an application whose own files compress past about 384 MiB exceeds V8's string limit on
the leader and stops the clone. Success means the application was prepared, not that its workers loaded
it.
