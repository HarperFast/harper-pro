---
section: 'Known Issues'
---

### Removing a Live Node Can Lose Its Undelivered Writes

`remove_node` of a node that is still running does not wait for that node's writes to reach a peer. A write the node accepted just before its removal, or while a link to its peers was down, can be lost, and nothing reports it. On a sharded table, a node that owns none of a record's slots holds a write it accepted until it delivers it to the owners, so removing a [replica node](#replica-nodes-in-a-spare-shard) can lose writes the same way; scale-in of replica nodes is not supported yet. Removing a node that has already stopped is not affected. Tracked in [harper-pro#1348](https://github.com/HarperFast/harper-pro/issues/1348).
