---
section: 'Replication'
---

### Shard Owners in cluster_status

`cluster_status` now shows who owns what in a sharded database. Each entry of `sharding` that has an installed map lists `shards`, one item per shard with its slot count and the names of its owners, and `nodesOwningNoSlots`, the cluster members that own no slot. One response from any node is enough to see the layout. Nothing is reported without an installed map: the responding node does not fall back to its own `replication.shard` setting. See [Sharding Status](/reference/v5/replication/clustering#sharding-status).

The top-level `shard` field also reports shard `0`. It used to be left out for a node in that shard.
