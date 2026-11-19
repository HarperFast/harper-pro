---
section: 'Replication'
---

### No Replication Hole From a Clone's Temporary Admin

A clone authenticated by token or certificate creates a temporary `clone-temp-admin` user and deletes it once synchronized. With cluster record locks on, a node that then joined by base copy from a node still holding that deleted user recorded a replication hole in `system.hdb_user`, and logged that cluster locks could not prove freshness for it until the node was recloned. The copy now carries the deletion (see Deletions in a Base Copy), so the joining node records no hole. Both nodes need this release, and a temporary admin deleted before the copy source upgraded still arrives without its deletion and leaves the hole, as that note describes; it stops once the source's record of the delete expires after `logging.auditRetention`. A node that already recorded the hole keeps refusing cluster locks on `system.hdb_user` from the node that deleted the temporary admin until it is recloned. See [harper-pro#1451](https://github.com/HarperFast/harper-pro/issues/1451).
