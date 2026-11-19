---
section: 'Replication'
---

### No Replication Hole From a Clone's Temporary Admin

A clone authenticated by token or certificate, and installed without an admin username, creates a temporary `clone-temp-admin` user and deletes it once synchronized. With cluster record locks on, a node that then joined by base copy from a node still holding that deleted user recorded a replication hole in `system.hdb_user`, and logged that cluster locks could not prove freshness for it until the node was recloned. The copy now carries the deletion (see Deletions in a Base Copy), so the joining node records no hole. Both nodes need this release. A deletion the copy source recorded before it ran 5.4 still arrives without the deletion and leaves the hole, as that note describes, until the source's record of it expires after `logging.auditRetention`. A node that already recorded the hole keeps it: until that node is recloned, it refuses a cluster lock on `system.hdb_user` whenever the lock needs proof that the node has every write from the node that deleted the temporary admin. See [harper-pro#1451](https://github.com/HarperFast/harper-pro/issues/1451).
