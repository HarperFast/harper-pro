---
section: 'Replication'
---

### Errors From Another Node Keep Their Status

When `remove_node` is sent to a node other than the one being removed, the node being removed can refuse to start the removal (it is a shard's only owner, its peers have yet to return its writes, or its storage engine or storage layout cannot be drained) or to cancel it. Such a refusal returned `500`. It now returns the status the node being removed decided, such as `409`. The same applies to any operation whose error one node returns directly from another. A refusal from a node that has not been upgraded returns `400`.
