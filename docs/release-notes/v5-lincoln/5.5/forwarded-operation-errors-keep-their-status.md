---
section: 'Replication'
---

### Errors From Another Node Keep Their Status

An operation that one node carries out by asking another, such as `remove_node` sent to a node other than the one being removed, returned `500` when the other node refused it. The response now has the status the other node decided, for example `409`. A refusal from a node that has not been upgraded returns `400`.
