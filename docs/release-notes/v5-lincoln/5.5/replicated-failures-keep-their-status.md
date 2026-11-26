---
section: 'Replication'
---

### A Failed Peer's Status in `replicated`

When a replicated operation fails on a peer, its entry in the response's `replicated` array is `{ "status": "failed", "reason": "...", "node": "..." }`. When the peer answered with an error, such as a `400` for a configuration parameter it does not recognize, the entry now also has `statusCode`, the status that peer decided. A peer that could not be reached or did not answer has no `statusCode`. Neither does an error from a peer that has not been upgraded, unless it is a `ClientError`, which reads as `400`. See [Set Configuration](/reference/v5/configuration/operations#set-configuration).
