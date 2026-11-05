---
section: 'Replication'
order: 50
---

### Local Replicas of Records Fetched From Another Node

On RocksDB, a table sharded with `setResidency` lets a node that reads a record it does not hold keep the fetched record as a local replica instead of moving it. The replica is served locally until an owner writes the record or its lifetime passes, set by the new `@table` arguments [`replicaExpiration` and `replicaRefreshFraction`](/reference/v5/database/schema#replicaexpiration-and-replicarefreshfraction) (default one hour, renewed by reads after half of it). Local replicas are RocksDB-only; LMDB continues to proxy remote reads without storing replicas or running a replica sweep.
