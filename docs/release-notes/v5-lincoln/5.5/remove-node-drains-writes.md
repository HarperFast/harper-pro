---
section: 'Replication'
order: 40
---

### `remove_node` Waits for a Live Node's Writes

Removing a live node with `remove_node` could lose writes that only that node held: writes it accepted just before removal, while a peer link was down, or to sharded records it does not own. The node being removed now stops accepting local writes first, and its membership is deleted only after every peer that must hold its writes reports them committed. The wait is bounded by `timeout`; `force: true` removes without waiting, and `cancel: true` stops a removal that timed out. A node that cannot be reached, or the only owner of a shard, now needs `force: true`. `replicatedConfirmation` on RocksDB also no longer counts a 5.5 peer that has received a later-timestamped write but not yours; a peer on an earlier version is still counted by timestamp. See [Remove Node](/reference/v5/replication/clustering#remove-node), [harper-pro#1348](https://github.com/HarperFast/harper-pro/issues/1348) and [harper-pro#1351](https://github.com/HarperFast/harper-pro/issues/1351).
