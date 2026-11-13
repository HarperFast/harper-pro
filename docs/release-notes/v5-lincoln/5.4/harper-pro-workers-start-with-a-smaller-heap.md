---
section: 'Memory'
order: 20
---

### Harper Pro Workers Start With a Smaller Heap

Harper Pro now builds with core's comment-free production output, which saves about 10 MB of JavaScript heap in each worker. Its workers also load LMDB, `node-forge` and lodash only when a feature that needs them runs. This adds to the [smaller per-thread baseline](#smaller-per-thread-baseline) in core. See [harper-pro#992](https://github.com/HarperFast/harper-pro/pull/992) and [harper-pro#995](https://github.com/HarperFast/harper-pro/pull/995).
