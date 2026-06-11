# Smoke tests

Nightly canaries that deploy each customer-facing component onto a 2-node in-process Harper
cluster built from this repo's `dist/`, seed a little data, and run a short low-load check.
Adapted from the v5 QE performance tests (k6 + JMeter) in `harper-qe-logbook`.

Not the full v5 load benchmarks. Each canary runs at a low fixed rate for ~10-15s and asserts
**0 failed requests** plus a generous p95.

## What runs

| Component   | Source repo                      | Canary                    | Validates                                    |
| ----------- | -------------------------------- | ------------------------- | -------------------------------------------- |
| risk-query  | `HarperFast/risk-query`          | k6 GET `/risq`            | KV upsert (seed) + read + replication        |
| redirector  | `HarperFast/redirector`          | k6 GET `/checkredirect`   | CSV rule load + lookup + replication         |
| early-hints | `HarperFast/early-hints`         | k6 GET `/hints`           | TS build + `/site-images` seed + replication |
| acl-connect | `HarperFast/acl-connect-example` | JMeter MQTT (MQTTS :8883) | JWT auth + ACL authorization + delivery      |

Pinned refs live in [`manifest.mjs`](./manifest.mjs).

## Layout

```
run-smoke.mjs           # runner: globs components/*.smoke.mjs, serial, --component=<name>
manifest.mjs            # component repo + pinned ref + checkout dir
lib/                    # cluster, deploy, http, k6, jmeter, mqtt, canary helpers
components/*.smoke.mjs  # one node:test suite per component (deploy, seed, canary)
k6/*.canary.js          # k6 scripts (adapted from each repo's perf test)
jmeter/*.canary.jmx     # acl-connect MQTT plan (adapted, reduced load)
fixtures/redirector/    # deterministic redirect rules + matching paths
```

## Running locally

Prerequisites: a built `dist/` (`npm run build`) and [k6](https://k6.io/) on PATH. acl-connect
also needs Java + JMeter + the [mqtt-xmeter](https://github.com/emqx/mqtt-jmeter) plugin (its
canary is skipped if `jmeter` is missing).

Point the suite at local component checkouts via `SMOKE_COMPONENTS_ROOT`:

```bash
npm run build
SMOKE_COMPONENTS_ROOT=~/Desktop npm run test:smoke -- --component=risk-query
```

Without `SMOKE_COMPONENTS_ROOT`, checkouts are expected in `smokeTests/.components/<dir>` (where
the CI workflow places them). Deps are installed and early-hints is built on demand.

## How a canary works

Each `*.smoke.mjs`:

1. `startCluster(2)` brings up two nodes on isolated loopback addresses, joined and replicating,
   running `dist/bin/harper.js` via `@harperfast/integration-testing`.
2. `deployComponent(...)` calls `targz` then `deploy_component` with `replicated: true, restart: true`.
3. Seeds via the node's HTTP API using `admin` / `Abc1234!`.
4. Runs the k6 or JMeter canary and asserts it passed.
5. `teardownCluster(...)`.

## CI

[`.github/workflows/smoke-tests.yaml`](../.github/workflows/smoke-tests.yaml) runs nightly and
on `workflow_dispatch`. Matrix per component, App-token checkout of the pinned component repos,
build dist/, install canary tooling, run `run-smoke.mjs --component=<name>`. k6/JMeter output
appears in the job log; Harper server logs upload on failure.

## Adding a component

The manifest is shared between both tiers, so a new component touches both `smokeTests/` and
`stressTests/`.

1. Add an entry to [`manifest.mjs`](./manifest.mjs).
2. Smoke canary: add `smokeTests/k6/<name>.canary.js` (or a JMeter plan) and
   `smokeTests/components/<name>.smoke.mjs` following an existing one.
3. Stress: add `stressTests/k6/<name>.stress.js` and `stressTests/components/<name>.stress.mjs`
   following an existing one.
4. Add a matrix row in both
   [`smoke-tests.yaml`](../.github/workflows/smoke-tests.yaml) and
   [`component-stress-tests.yaml`](../.github/workflows/component-stress-tests.yaml).
