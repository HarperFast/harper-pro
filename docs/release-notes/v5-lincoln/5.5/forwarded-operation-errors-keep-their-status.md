---
section: 'Replication'
---

### Errors From Another Node Keep Their Status

When `remove_node` is sent to a node other than the one being removed, a refusal the node being removed decided returned `500`. It now returns the status that node decided, for example `409`. The same applies to any operation whose error one node returns directly from another. A refusal from a node that has not been upgraded returns `400`.
