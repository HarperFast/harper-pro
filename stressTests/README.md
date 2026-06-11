# Stress tests

Load-tier companion to [`smokeTests/`](../smokeTests/README.md). Same deploy/seed/run flow, but
with the v5 QE perf profile restored: multi-minute multi-RPS k6 scenarios for the HTTP components
and the v5-verbatim JMeter MQTT profile for acl-connect.

Use **smoke** (`npm run test:smoke`) for the nightly pass/fail signal. Use **stress**
(`npm run test:stress:components`) on demand or weekly. Stress costs ~6 min per k6 component and
up to 10 min for acl-connect at v5 load.

Distinct from the replication-layer **Stress Tests** workflow (`integrationTests/stress/`, gated
on `HARPER_RUN_STRESS_TESTS`). Same word, different scope.

## What runs

| Component   | Tool   | Profile                                                                           | Threshold                     |
| ----------- | ------ | --------------------------------------------------------------------------------- | ----------------------------- |
| risk-query  | k6     | RPS scenarios **50/100/300/500/900** x **60 s plateau** (chained, `+10 s` buffer) | `p(95) < 500 ms` per scenario |
| redirector  | k6     | Same as risk-query                                                                | `p(95) < 500 ms` per scenario |
| early-hints | k6     | Same as risk-query                                                                | `p(95) < 500 ms` per scenario |
| acl-connect | JMeter | 1 publisher (100 ms timer) + **20000 subscribers** (120 s ramp) x **600 s**       | 0 failed samples              |

All profiles match the v5 reports in `harper-qe-logbook/releases/v5/` and are env-overridable
via `RATE_LEVELS`, `RATE_PLATEAU`, `DUR_P95`, `STRESS_SUB_THREADS`, and friends.

## Layout

```
run-stress.mjs                # runner: globs components/*.stress.mjs, serial, --component=<name>
components/*.stress.mjs       # one node:test suite per component
k6/*.stress.js                # k6 scripts (v5 multi-RPS profile)
jmeter/acl-connect.stress.jmx # v5-faithful publisher + subscriber plan, -J parameterized
```

Reuses [`smokeTests/lib/`](../smokeTests/lib/) and [`smokeTests/manifest.mjs`](../smokeTests/manifest.mjs).

## Running locally

Prerequisites: a built `dist/` (`npm run build`) and [k6](https://k6.io/) on PATH. acl-connect
also needs Java + JMeter + the [mqtt-xmeter](https://github.com/emqx/mqtt-jmeter) plugin (its
run is skipped if `jmeter` is missing). One k6 component is ~6 min; the full sweep ~25 min (plus
acl-connect's 10).

```bash
npm run build
SMOKE_COMPONENTS_ROOT=~/Desktop npm run test:stress:components -- --component=risk-query
```

## How a stress run works

Same flow as the smoke canary; see [How a canary works](../smokeTests/README.md#how-a-canary-works).
The k6 script runs five chained `constant-arrival-rate` scenarios (`rps_50` through `rps_900`,
60 s each with a 10 s buffer) and asserts a `p(95) < 500 ms` threshold per scenario. The
acl-connect leg runs the v5-faithful JMeter plan (1 publisher + 20000 subscribers, 600 s).

## CI

[`.github/workflows/component-stress-tests.yaml`](../.github/workflows/component-stress-tests.yaml)
runs **weekly on Sunday** at 08:00 UTC and on `workflow_dispatch`. Matrix per component, same
App-token checkout as the smoke workflow. `timeout-minutes: 60`. The acl-connect leg dials the
v5-default 20000 subscribers down to a runner-safe ceiling via env (see the workflow); local
runs use v5 defaults.

## acl-connect note

The JWT pins the MQTT `clientID` claim, so all 20000 subscriber threads share
`clientId=subClient` and most sessions are kicked as duplicates. The v5 report observed ~6052 of
20000 connections established before the load generator (a single MacBook) became the
bottleneck. Expected behaviour of this configuration, not a Harper defect. The smoke tier uses
1 pub / 1 sub which is unambiguous.

## Adding a component

See [Adding a component](../smokeTests/README.md#adding-a-component) in the smoke README. The
manifest is shared and both tiers are added together.
