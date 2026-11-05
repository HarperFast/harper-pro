---
section: 'Replication'
order: 20
---

### Base Copies That Could Not Finish

[Stop forcing base copies that never finish](https://github.com/HarperFast/harper-pro/pull/1249) fixes three ways a base copy could start without need or restart forever. The same fixes are also in 5.3.6 ([harper-pro#1262](https://github.com/HarperFast/harper-pro/pull/1262)), except refusal as a sharded owner: `stuckCopy` there has only `retrying` and `held`.

- **Idle databases no longer force copies.** A peer used to force a base copy whenever a returning node's position was older than `logging.auditRetention` or its own oldest retained entry, even for a database it had not written to since. It now forces one only when a prune may have removed history the node would replay. See [When a Peer Forces a Base Copy](/reference/v5/replication/overview#when-a-peer-forces-a-base-copy).
- **Rows with no origin name now copy.** Rows whose origin has no node name on the sending node, such as data migrated from v4, made the receiver fail and restart the copy. The sender now names that origin `unnamed-origin-<id>@<node name>`, and those names can appear in logs. See [Rows From Unnamed Origins](/reference/v5/replication/overview#rows-from-unnamed-origins).
- **Stuck copies are held and reported.** When a copy starts five times from the same position, or the receiving node refuses it as a sharded owner, that node now holds its reconnects to the peer for that database: 60 seconds at first, then longer each time, up to 15 minutes. Before, it retried every few seconds. `cluster_status` reports the state as `stuckCopy` on the database socket, and each change of state logs one line. See [Stuck Copies](/reference/v5/replication/clustering#stuck-copies).

**Upgrade impact:** after upgrading from a version before 5.3.6, a transaction log that was already purged empty can force one more base copy of its database for each node returning with a position older than that purge.
