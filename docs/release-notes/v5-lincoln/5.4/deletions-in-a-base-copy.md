---
section: 'Replication'
order: 20
---

### Deletions in a Base Copy

A node that joined or rejoined a cluster through a base copy kept no record of rows the copy source had deleted, so a later delivery of a write older than the delete recreated the row on that node alone. A removed node could come back in that node's `hdb_nodes` and sharding membership this way. On RocksDB storage the copy now carries each deletion the source recorded with this release, and the receiving node keeps it, so an older write loses there as it does on the source. Both nodes need this release: a receiver on an earlier release still keeps no deletion from a copy, and the copy still drops a deletion recorded before the upgrade, on LMDB, or followed by a publish to the same key. A node that joined by copy before upgrading keeps that exposure for rows deleted before it joined, until the source's own record of those deletes expires after `logging.auditRetention` and the source accepts the same older write too. See [harper-pro#1331](https://github.com/HarperFast/harper-pro/issues/1331).
