---
section: 'Replication'
---

### A Table's Expiration Reaches a Node That Joins

A node that joined with `add_node`, or by a credential clone, received its tables with no `expiration` or `eviction`, so rows there never expired. Table definitions sent to a node that joins with `add_node` now carry both values; a credential clone, which creates its tables before replication starts, gets the leader's `expiration` only. They apply only when the receiving node creates the table, so a node's own `@table` declaration still wins, and a table that already exists on the node keeps what it has. Older nodes in the cluster ignore the new values. See [harper-pro#1233](https://github.com/HarperFast/harper-pro/pull/1233).
