---
section: 'Replication'
order: 62
---

### Cluster Record Locks Across Node Restarts and Stopped Nodes

Cluster record locks stay available while a node restarts:

- **A restarted lock home recalls its delegations.** A home that restarted used to answer `503` on every key it homes for about six minutes while it waited out every delegation its previous run could have issued. It now asks the other members of its ring and ends that wait as soon as they answer. When they cannot be reached, it still waits. ([harper-pro#1059](https://github.com/HarperFast/harper-pro/pull/1059))
- **Keys a restarted node held are released.** Keys a node held for others stayed granted on their home until the lease ran out, and the node's own home keys failed with `503` while it rejoined. The restart now retires the node's old grants, and other nodes answer "recovering" instead of failing. ([harper-pro#1193](https://github.com/HarperFast/harper-pro/pull/1193))
- **A lock waits out a restarting peer.** A `lock()` that needs an up-to-date check from a node that is restarting, including a worker restart, keeps asking until its own timeout instead of failing with `503` on the first refusal or after 10 seconds. ([harper-pro#1196](https://github.com/HarperFast/harper-pro/pull/1196), [harper-pro#1205](https://github.com/HarperFast/harper-pro/pull/1205))

`record_lock_apply_homes` accepts `fenced`, a list of nodes you attest are stopped outside Harper, so a home-map change can complete past a node that is gone for good instead of failing with `503` or `409`. It needs a majority of the old map's nodes to answer. When it refuses, its `409` lists the per-node steps that recover. See [Cluster Record Locks](/reference/v5/replication/overview#cluster-record-locks), [harper-pro#1065](https://github.com/HarperFast/harper-pro/pull/1065) and [harper-pro#1305](https://github.com/HarperFast/harper-pro/pull/1305).
