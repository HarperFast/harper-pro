---
section: 'Known Issues'
---

### Removing a Node Can Lose Its Undelivered Writes

`remove_node` does not wait for the removed node's writes to reach a peer. A write the node accepted just before its removal, or while a link to its peers was down, can be lost, and nothing reports it. This applies to a node that has stopped too, if it stopped before delivering those writes. On a sharded table, a node that owns none of a record's slots holds a write it accepted until it delivers it to the owners, so removing a [replica node](#replica-nodes-in-a-spare-shard) can lose writes the same way; scale-in of replica nodes is not supported yet. Tracked in [harper-pro#1348](https://github.com/HarperFast/harper-pro/issues/1348).
