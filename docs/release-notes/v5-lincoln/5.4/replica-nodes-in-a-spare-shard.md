---
section: 'Replication'
order: 12
---

### Replica Nodes in a Spare Shard

`replication.spareShards` lists shard IDs that a default map gives no slots, so a cluster can keep every slot on one shard and hold the other IDs for later, and the first database deployed after setup no longer spreads slots across them. Every node must share the list. A clone can now join a sharded cluster as a replica node with `--shard replica` (or `CLONE_SHARD=replica`). It takes a listed shard ID that owns no slots, preferring the one other replica nodes already hold, copies no full records, and reads them from the owners. `--shard auto` now skips such spare shards, so it no longer places a new data-holding node in a shard that owns nothing. See [Spare shard IDs](/reference/v5/replication/sharding#spare-shard-ids), [Replica nodes in a spare shard](/reference/v5/replication/sharding#replica-nodes-in-a-spare-shard) and [harper-pro#1344](https://github.com/HarperFast/harper-pro/issues/1344).
