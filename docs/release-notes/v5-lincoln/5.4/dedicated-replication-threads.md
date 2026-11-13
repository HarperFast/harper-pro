---
section: 'Replication'
order: 40
---

### Dedicated Replication Threads

Nodes with two or more HTTP worker threads now start worker threads that run replication only: `replication.threads` defaults to half of `threads.count`, rounded down. These threads own the replication port and every subscription, so a peer catching up no longer competes with application requests. They need a replication port of their own (`replication.securePort` or `replication.port`). Without one, an omitted `replication.threads` falls back to `0` with a warning, and an explicit value stops startup.

The threads load no application code, which limits applications that use `setResidency`, `setResidencyById` or `setComputedAttribute` on an indexed attribute. Those hooks are deprecated in 5.4 and warn when registered. When `replication.threads` is omitted and an application registers one at startup, no replication threads start and a warning names the tables. Set `replication.threads: 0` to keep replication on the HTTP worker threads. See [Dedicated Replication Threads](/reference/v5/replication/overview#dedicated-replication-threads).
