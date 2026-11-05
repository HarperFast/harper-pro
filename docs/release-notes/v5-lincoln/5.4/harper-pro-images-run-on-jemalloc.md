---
section: 'Container Images'
order: 10
---

### Harper Pro Images Run on jemalloc

The `harperfast/harper-pro` image, its pointer-compression variant (the `-pc` tags) and the GPU image (`harperfast/harper-pro-gpu`) now install the distribution's jemalloc package (`libjemalloc2`, version 5.3.0) and set `LD_PRELOAD=libjemalloc.so.2`, so every process in the container allocates memory with jemalloc instead of glibc malloc. jemalloc runs with its default settings; the images set no `MALLOC_CONF`. RocksDB's allocation pattern fragments glibc malloc's heap. In tests on Harper Pro 5.3.4 under a 3 GB memory limit, jemalloc used about 5% less memory (RSS), and its memory grew about half as fast. In short runs without a memory limit it gave YCSB workload A (half reads, half updates) about 5% more throughput, with no measurable difference in peak memory. Expect the memory saving under a memory limit, and not on every workload.

- To run a container on glibc malloc, set `LD_PRELOAD` to an empty value: `docker run -e LD_PRELOAD= harperfast/harper-pro`.
- A deployment that sets its own `LD_PRELOAD`, for example to load an instrumentation library, replaces jemalloc. To keep both, list both: `LD_PRELOAD="libjemalloc.so.2 /path/to/other.so"`.
- glibc malloc settings such as `MALLOC_ARENA_MAX` have no effect while jemalloc is preloaded.

The OpenShift image (`harperfast/harper-pro-openshift`) and the open source `harperfast/harper` image are unchanged and still use glibc malloc. See [harper-pro#1132](https://github.com/HarperFast/harper-pro/pull/1132).
