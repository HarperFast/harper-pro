---
section: 'Replication'
order: 50
---

### A Default Record-Lock Home Map

`record_lock_apply_homes` takes `default: true` to apply one home map for the whole cluster. Every database without a map of its own uses it, including databases created afterwards, so a database is lockable as soon as it exists instead of waiting for a per-database map to be applied and drained. A map of a database's own still takes precedence. A membership change through the default moves every database that uses it, with the same staging, drain and activation as a per-database map. See [Default Home Map](/reference/v5/replication/overview#default-home-map) and [harper-pro#1452](https://github.com/HarperFast/harper-pro/issues/1452).
