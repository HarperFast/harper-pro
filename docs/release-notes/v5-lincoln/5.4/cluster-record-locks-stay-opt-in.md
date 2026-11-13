---
section: 'Replication'
order: 60
---

### Cluster Record Locks Stay Opt-In

Cluster record locks remain off unless `replication.recordLocks: true` is set. Harper Fabric turns them on for its clusters; a self-hosted cluster opts in. While they are off, a cluster `lock()` on a replicated table answers `503`, and the message now names the fix: set `replication.recordLocks: true` on every node, restart each one, and apply a home map with `record_lock_apply_homes`. With locks on and no home map applied yet, the `503` names `record_lock_apply_homes` too. Conditional REST writes do not need cluster record locks: while they are off, those writes are checked without a lock, as in 5.3 (see [Conditional Writes Without Cluster Record Locks](#conditional-writes-without-cluster-record-locks)). See [Cluster Record Locks](/reference/v5/replication/overview#cluster-record-locks), [harper-pro#1316](https://github.com/HarperFast/harper-pro/pull/1316) and [harper-pro#1350](https://github.com/HarperFast/harper-pro/pull/1350).
