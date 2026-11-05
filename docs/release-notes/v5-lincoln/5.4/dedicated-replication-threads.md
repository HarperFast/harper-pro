---
section: 'Replication'
order: 40
---

### Dedicated Replication Threads

`replication.threads` (default `0`) starts worker threads that run replication only. They own the replication port and every subscription, so a peer catching up no longer competes with application requests. These threads load no application code, which limits applications that use `setResidencyById` or `setComputedAttribute` on indexed attributes. See [Dedicated Replication Threads](/reference/v5/replication/overview#dedicated-replication-threads).
