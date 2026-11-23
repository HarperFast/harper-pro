---
section: 'Replication'
---

### A Clone of a Clone Learns the Whole Cluster

A node started as a clone kept its record of its leader to itself, so a node later cloned from it never learned that leader, refused its connections, and reached it only through the node in between. Removing that node split the cluster without an error. A clone now makes that record an ordinary, replicated one when the clone completes. A leader running a version before 5, and a node an operator adds with [`isLeader: true`](/reference/v5/replication/clustering#add-node), still stay off the rest of the cluster. Nodes cloned before this release keep their existing record: clone new nodes from the first leader, or send `isLeader: false` for the leader on the node that holds the record. See [harper-pro#1487](https://github.com/HarperFast/harper-pro/issues/1487).
