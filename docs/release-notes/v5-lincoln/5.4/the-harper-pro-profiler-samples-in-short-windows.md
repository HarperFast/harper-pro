---
section: 'Analytics'
order: 10
---

### The Harper Pro Profiler Samples in Short Windows

Harper Pro's CPU profiler used to sample every worker continuously, so each worker's `utilization` read about 70% at idle and every worker paid a stack walk every 50 ms. It now samples only for one `aggregatePeriod` before each capture: from application load until the second capture, two periods later, and then for one period in every thousand. Each `hdb_raw_analytics` entry whose `utilization` overlapped sampling carries a new `profiler-sampling` metric, so a consumer can set that sample aside. Ending each window also stops a wedged V8 profiler thread ([harper-pro#1021](https://github.com/HarperFast/harper-pro/issues/1021)). `analytics.profiling: false` still keeps the profiler off. See [`utilization` and the CPU profiler](/reference/v5/analytics/overview#utilization-and-the-cpu-profiler).
