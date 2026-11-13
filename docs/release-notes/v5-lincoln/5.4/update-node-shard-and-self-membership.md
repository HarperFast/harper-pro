---
section: 'Replication'
---

### update_node Changes and a Node's Own Shard

`update_node` that changes nothing but `revoked_certificates` and/or `shard` now writes the change to this node's record of the target without contacting it, as documented. It used to run the full `add_node` exchange, which reopened replication connections and replaced a requested `shard` with the target's own setting. On a node's own hostname, a `shard` other than its `replication.shard` is refused with 400.

`cluster_status` now reports a sharded database as `held`, with the error `local shard membership disagrees with replication.shard`, when the responding node's own record and its setting disagree about a shard in the installed map. Write admission already refused those slots; the status said `available`. See [Update Node](/reference/v5/replication/clustering#update-node) and [Sharding Status](/reference/v5/replication/clustering#sharding-status).
