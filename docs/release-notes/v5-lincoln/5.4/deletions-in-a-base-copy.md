---
section: 'Replication'
order: 20
---

### Deletions in a Base Copy

A node that joined or rejoined a cluster through a base copy kept no record of rows the copy source had deleted, so a later delivery of a write older than the delete recreated the row on that node alone. A removed node could come back in that node's `hdb_nodes` and sharding membership this way. The copy now carries each deletion, and the receiving node keeps it, so an older write loses there as it does on the source. Both nodes need this release: a receiver on an earlier release still keeps no deletion from a copy, and a node that joined by copy before upgrading stays exposed for rows deleted before it joined until those deletions age out of `logging.auditRetention`. See [harper-pro#1331](https://github.com/HarperFast/harper-pro/issues/1331).
