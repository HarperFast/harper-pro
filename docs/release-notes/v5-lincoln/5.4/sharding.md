---
section: 'Replication'
order: 10
---

### Sharding

`@sharded` hashes primary keys to fixed slots on every thread, including dedicated replication workers. Per-database slot maps remain authoritative after initialization; `replication.shards` supplies the deployment shard set for a first default map. Conversion checks support equivalent legacy by-id policies without rewriting records. Attribute-derived policies and custom expressions are refused pending [concurrent-move design (#1178)](https://github.com/HarperFast/harper-pro/issues/1178). See [Schema-defined sharding](/reference/v5/replication/residency).

Sharding configuration failures are isolated to the affected database. A live disagreement holds that database until the configuration is repaired on all peers; healthy databases in the same application keep serving, including during worker replacement. Invalid configuration at process startup still requires a repaired full restart because its audit replay was deferred. First-time sharding initialization waits for the configured members; owner recovery requires a certified same-shard source or a complete backup. See [Configuration failures and recovery sources](/reference/v5/replication/residency#configuration-failures-and-peer-identity).

Co-owner snapshot recovery does not restore the replacement's former local audit lineage. Cluster record-lock freshness treats the recovered database as recloned, including its ordinary tables; use a complete backup to preserve that history. See [Recovery sources](/reference/v5/replication/residency#recovery-sources).

Snapshot-only recovery of a sharded node requires a fresh root and a new node name. Reusing the original name requires a complete stopped-node backup preserving audit through the last accepted write. A reused name missing its origin history refuses sharded writes and recovery-source eligibility, with both remedies in cluster status. See [sharding recovery](/reference/v5/replication/residency#recovering-a-lost-node).
