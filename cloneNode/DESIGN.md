# cloneNode design notes

## A clone copies filesystem-only applications as the leader packaged them

**Invariant.** A clone marked `cloned` and `Available` holds every filesystem-only application of its
leader — one without a config `package`, so nothing reinstalls it on start — including the leader's
`node_modules`. An application it could not copy stops clone setup: the node stays running, Unavailable
and uncloned, and the next start replays setup. A dot-prefixed directory (`.git`) is not an application:
the loader never loads one and `package_component` refuses its name, so the clone skips it. Any other
name outside `PROJECT_NAME_PATTERN` stops setup without a request: `package_component` would refuse it, or
cut `app.v2` to `app` and return a different application.

**Why.** Rebuilding `node_modules` with `npm install` loses whatever npm cannot reproduce: a `file:`
dependency into `node_modules`, a bundler's private workspace packages (a Next.js standalone build), and
a payload deploy's install options and registry credentials, which are request-scoped and never
persisted (harper-pro#1047).

**Where.** `applicationClone.ts` (`cloneFilesystemOnlyApplications`); `leaderHTTP.ts` streams the archive
over HTTP, and leaders that predate `stream` answer with the base64 envelope instead, because operation
validation allows unknown keys. Cert auth gets the envelope: the replication socket carries an
operation's answer as one message. Tests: `unitTests/cloneNode/applicationClone.test.mjs`,
`integrationTests/cloneNode/cloneNode.test.mjs`.

**Limits.** The copy is core's package of the leader's tree: links dereferenced, core's exclusions
applied. The leader packs the target of the loader-owned `node_modules/harper` link inside every npm
sub-component (HarperFast/harper#3207), and at the top level too before 5.3.0; the clone's loader
replaces each copy with its own link. It assumes leader and clone share a platform, as any payload deploy that
carries `node_modules` already does. Success means the application was prepared, not that its workers
loaded it.
