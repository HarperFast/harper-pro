## `replication`

Native WebSocket-based replication (Plexus). Added in: v4.4.0. See [Replication](../replication/overview.md) and [Clustering](../replication/clustering.md).

```yaml
replication:
  hostname: server-one
  url: wss://server-one:9933
  databases: '*'
  routes:
    - wss://server-two:9933
```

- `hostname` <VersionBadge type="changed" version="v5.3.0" /> — This instance's hostname within the cluster. Subject to the same bare hostname or IP literal requirement as [`node.hostname`](#node) — a URL, `host:port`, or non-string value fails startup. When both are set, `node.hostname` wins.
- `url` — WebSocket URL peers use to connect to this instance
- `databases` — Databases to replicate; _Default_: `"*"` (all). Each entry supports `name`, `replicateTo`, and `sharded`
- `routes` — Peer nodes; URL strings or `{hostname, port, startTime, revokedCertificates}` objects
- `privateUrls` <VersionBadge version="v5.4.0" /> — Addresses where peers on a private network can reach this instance, as `{url, network}` objects. `url` must be a `wss://` URL with no credentials; `network` is a tag you choose for the network (for example a VPC id and region). A peer that dials from the same network uses this URL instead of `url`. See [Private Network Addresses](../replication/overview.md#private-network-addresses)
- `network` <VersionBadge version="v5.4.0" /> — The network this instance dials peers from, in addition to the networks in its own `privateUrls`. Needed only for an instance that is not itself reachable on that network
- `port` — Replication port
- `securePort` — Secure replication port; _Default_: `9933` (changed from `9925` in v4.5.0)
- `threads` — Worker threads dedicated to replication, which then own the replication port and every subscription and load no application code; an explicit positive value requires `port` or `securePort`; see [Dedicated Replication Threads](../replication/overview.md#dedicated-replication-threads); _Default_: half of `threads.count`, rounded down, so `0` below two HTTP worker threads; an omitted value falls back to `0`, with a warning, when there is no dedicated replication port or an application registers a hook these threads cannot run; set `0` to keep replication on the HTTP worker threads (Added in: v5.4.0)
- `recordLocks` — Cluster-wide `lock()` on replicated databases, and from v5.4.0 lock-backed conditional REST writes; set it on every node, then apply a home map with `record_lock_apply_homes`; see [Cluster Record Locks](../replication/overview.md#cluster-record-locks). Fabric turns it on itself. Requires RocksDB, judged from the engine each replicated database is opened on: a node with any replicated database still on LMDB (as after an in-place upgrade from v4) runs with record locks off and logs why; _Default_: `false` (Added in: v5.3.0)
- `enableRootCAs` — Verify against Node.js Mozilla CA store; _Default_: `true`
- `pingInterval` — Interval between replication keep-alive pings (ms); _Default_: `30000`
- `pingTimeout` — Time without received socket activity before a replication connection is considered dead (ms); _Default_: twice `pingInterval`.
- `confirmationTimeout` — Timeout in milliseconds for explicit `replicatedConfirmation`, and from v5.5.0 for waits started by `confirmation` and `recordLockConfirmation` (a `recordLockConfirmation` wait also ends within about twice `pingTimeout` of its peers dropping), read when a waiter starts. _Default_: `900000`, or `blobTimeout` when greater. An explicitly configured value overrides that fallback, including a smaller value. Range: `1`–`2147483647`. (Added in: v5.4.0)
- `confirmation` <VersionBadge version="v5.5.0" /> — Peer confirmations a write waits for when it requests none. A write's own count, including `0`, takes precedence. Not applied to the `system` database. Refuses writes to a database this node replicates to fewer peers than the count. Read at startup. See [Default Confirmation Count](../replication/sharding.md#default-confirmation-count); _Default_: `0` (no wait)
- `recordLockConfirmation` <VersionBadge version="v5.5.0" /> — Minimum peer confirmations a commit waits for while its transaction holds a cluster record lock; the larger of this and the write's own count applies. While too few peers are connected, a locked commit is refused with `503` before it is written; a wait whose peers drop ends within about twice `pingTimeout`. Has no effect while cluster record locks are off, including on LMDB. Read at startup. See [Confirming Locked Writes](../replication/overview.md#confirming-locked-writes); _Default_: `1` while `recordLocks` is `true`, otherwise `0`. Set `0` to commit locked writes without waiting, as a single-node cluster must.
- `blobTimeout` — Blob transfer timeout (ms); _Default_: `120000`
- `blobGapReconnectMs` — Interval (ms) for the blob-gap watchdog: when a transient blob save failure pins a replication resume cursor, the connection is forced to reconnect on this cadence so the gapped blob is re-streamed and, during a bulk copy, the copy resumes from the last banked cursor. Lower values heal gaps faster at the cost of more reconnects on a link whose faults never heal; _Default_: the `blobTimeout` value
- `copyCursorFlushBytes` — Bytes of applied bulk-copy data between durable flushes of the copy resume cursor (RocksDB); _Default_: `67108864`
- `copyCursorFlushIntervalMs` — Maximum time (ms) between durable flushes of the bulk-copy resume cursor (RocksDB); _Default_: `5000`
- `blobSendDrainTimeout` — Maximum time (ms) a worker waits for in-flight replication blob **sends** to finish before shutting down during a restart, so a rolling restart (e.g., a component deploy reload) doesn't interrupt a transfer in progress. Only sends that are still making progress are waited on; `0` disables draining; _Default_: `600000`
- `failOver` — Failover to alternate node if peer unreachable; _Default_: `true`
- `shard` — Shard ID for traffic routing; see [Sharding](../replication/sharding.md). A clone does not inherit its leader's; see [Cloning a node into a sharded cluster](../replication/residency.md#cloning-a-node-into-a-sharded-cluster)
- `shards` — Complete array of unique shard IDs, integers `0`–`65535`; order does not matter. Required for a declarative database with no installed map; custom-map conversion can omit it. All peers must agree, and the local `shard` must be included when configured. Changing it never recomputes an installed map; see [Complete shard-id set](../replication/sharding.md#complete-shard-id-set). (Added in: v5.4.0)
- `spareShards` — Array of shard IDs from `shards` that a default map gives no slots, so nodes can join them owning nothing. Must leave at least one shard of `shards` out; an empty array means no spares. All peers must agree. It does not change an installed map; see [Spare shard IDs](../replication/sharding.md#spare-shard-ids). (Added in: v5.4.0)
- `mtls.certificateVerification` — Certificate revocation checking (CRL/OCSP) for replication connections; see [Certificate Verification](../security/certificate-verification.md)
- `logging` — Replication event logging; sub-options: `path`, `level`, `tag`, `stdStreams`. See [Logging Configuration](../logging/configuration.md)
