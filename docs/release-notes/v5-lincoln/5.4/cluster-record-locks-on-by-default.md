---
section: 'Replication'
---

### Cluster Record Locks On by Default

`replication.recordLocks` now defaults to on. Before, a cluster-wide `lock()` on a replicated database, and a conditional REST write, answered `503` unless an operator had turned record locks on and published a home map on every node.

With the setting unset, the first cluster `lock()` on a database creates its home map from the nodes that replicate it. That happens only once all of those nodes run 5.4 and agree on the set. A node added later, and a node removed from the map, need an operator to apply a new map with `record_lock_apply_homes`.

`recordLocks: true` keeps the earlier behavior, with an operator publishing every home map. `recordLocks: false` turns cluster record locks off. On LMDB they stay off. See [Cluster Record Locks](/reference/v5/replication/overview#cluster-record-locks).
