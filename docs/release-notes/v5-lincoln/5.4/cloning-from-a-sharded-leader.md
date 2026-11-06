---
section: 'Replication'
---

### Cloning From a Sharded Leader

A node cloned from a leader with static sharding now joins. It used to copy the leader's `replication.shard` without saying so, and every copy of an `@sharded` database then failed, so it never finished and could hold the leader's database as well.

A clone now chooses its own shard with `--shard` or `CLONE_SHARD`: a shard number, or `auto` for the listed shard with the fewest live members. Cloning from a sharded leader with neither, and no shard already configured on the node, stops with an error naming the option. See [Cloning a node into a sharded cluster](/reference/v5/replication/residency#cloning-a-node-into-a-sharded-cluster).

A clone reports `Available` only when its sharded databases are ready, including the copy of its owned slots from a same-shard peer. A database whose copy keeps failing is named in the log with its last error, and fails the clone at its sync timeout. A leader that accepts a clone's request and never answers now counts as a failed attempt instead of holding setup forever.
