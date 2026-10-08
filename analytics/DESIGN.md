# Analytics (CPU profiling) design notes

## The profiler samples one period before each capture and is off in between (`profile.ts`)

`startAutomaticProfiling` schedules captures at one and two aggregate periods after application load and then every `min(period * 1000, 2^31-1)` ms (the cadence #821 kept; see `shippedRescheduleDelay`). `scheduleCapture` starts the @datadog/pprof time profiler one `samplingWindow()` (one aggregate period) before each capture, at once when the delay fits in the window, otherwise from a timer, and `captureProfile` stops it at the capture, restarting in the same native call only when the next window opens immediately (between the two startup captures). A worker therefore samples from load until the second capture and then for one period per thousand, instead of forever.

Why one period: `cpu-usage` is CPU seconds per aggregate period (hits x 50 ms) and the hot-location threshold (100 hits) assumes a period of samples, so a shorter window would change what every value means. Whoever restores per-period captures must shrink the window, because at that cadence a one-period window is always-on again.

Why it matters beyond cost: a running sampler inflates core's `utilization` for that worker. SIGPROF interrupts the worker's `poll` wait and libuv drops the interrupted wait's idle time, so `worker.performance.eventLoopUtilization` over-reports active time. Measured 2026-10 on Fabric stage nodes and locally: an idle 2-worker node reads 0.70 with the sampler running and 0.00 without, and under load the ratio falls (the poll returns with events before the next signal), so the metric inverts.

## `profiler-sampling` marks the utilization samples the sampler invalidated

`markProfilerSampling` is registered with core's `addAnalyticsListener`, which runs on the worker at every report flush with the outgoing `metrics`. When the sampler ran at any point since the thread's previous report, it pushes `{ metric: 'profiler-sampling', total: <ms sampled since that report>, count: 1 }`. Core appends the same report's `utilization` sample on the main thread, so a raw `hdb_raw_analytics` row carrying `profiler-sampling` is one whose utilization sample is inflated; an idle worker that reports nothing during a window flags its first report afterwards, which is the sample that spanned the window. In `hdb_analytics` the period's `total` is the sampled milliseconds and `count` the number of flagged reports. Core does not yet suppress those samples; it could, by skipping the `utilization` push when the report carries this metric.

## Running harper-pro from a VS Code-hosted agent

`ELECTRON_RUN_AS_NODE=1` is inherited from the VS Code extension host. node-gyp-build then looks for an _electron_ prebuild of `@datadog/pprof`, finds none, and the `analytics` component fails to load (`No native build was found for platform=darwin ... runtime=electron`). Unset it (`env -u ELECTRON_RUN_AS_NODE`) for builds, unit tests, and local instances.
