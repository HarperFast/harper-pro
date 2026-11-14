---
title: Replication Overview
sidebar_position: 10
sidebar_label: 'Overview'
---

<!-- Source: versioned_docs/version-4.7/developers/replication/index.md (primary) -->
<!-- Source: release-notes/v4-tucker/4.5.0.md (confirmed cluster status improvements, default port change, certificate revocation, expanded sharding) -->

# Replication Overview

Harper's replication system is designed to make distributed data replication fast and reliable across multiple nodes. You can build a distributed database that ensures high availability, disaster recovery, and data localization — all without complex setup. Nodes can be added or removed dynamically, you can choose which data to replicate, and you can monitor cluster health without jumping through hoops.

## Peer-to-Peer Model

Harper replication uses a peer-to-peer model where every node in your cluster can send data to and receive data from other nodes. Nodes communicate over WebSockets, allowing data to flow in both directions. Harper automatically manages these connections and subscriptions, so you don't need to manually track data consistency. Connections between nodes are secured and reliable by default.

## Configuration

### Connecting Nodes

To connect nodes to each other, provide hostnames or URLs in the `replication` section of `harper-config.yaml`. Each node specifies its own hostname and the routes (other nodes) it should connect to:

```yaml
replication:
  hostname: server-one
  routes:
    - server-two
    - server-three
```

Routes can also be specified as URLs or with explicit port numbers:

```yaml
replication:
  hostname: server-one
  routes:
    - wss://server-two:9933
    - hostname: server-three
      port: 9933
```

By default, replication connects on the secure port `9933`.

```yaml
replication:
  securePort: 9933
```

You can also manage nodes dynamically through the [Operations API](./clustering.md) without editing the config file.

### Gossip Discovery

Harper automatically replicates node information to other nodes in the cluster using [gossip-style discovery](https://highscalability.com/gossip-protocol-explained/). This means you only need to connect to one existing node in a cluster, and Harper will automatically detect and connect to all other nodes bidirectionally — unless those nodes advertise [directional routes](#controlling-replication-flow), as described below.

As of v5.2, this full-mesh, bidirectional auto-connect behavior applies to nodes with no directional routes. A node configured with [directional routes](#controlling-replication-flow) advertises a constrained registry record instead, so a node that discovers it — and has no directional route of its own for it — does not open a replication subscription to it. Containment is a property of the _discovered_ node's advertised record, not of the discovering node's configuration: configuring directional routes on one node does not stop that node from subscribing to a discovered peer that still advertises the legacy full-mesh record. See [Controlling Replication Flow](#controlling-replication-flow).

### Private Network Addresses

<VersionBadge version="v5.4.0" />

Some providers bill traffic between public addresses even inside one region, while traffic over a private network (a VLAN or VPC) is free or cheaper. Nodes that share a private network can replicate over it:

```yaml
replication:
  url: wss://server-one.example.com:9933
  privateUrls:
    - url: wss://10.0.0.5:9933
      network: vpc-1/us-east1
```

Each node publishes its `privateUrls` on its own `hdb_nodes` record, so peers learn them the same way they learn `url` (by [gossip discovery](#gossip-discovery), or from the node that ran `add_node`). A node dials a peer's private URL when the URL's `network` tag is one of its own: a network in its own `privateUrls`, or the `replication.network` setting. If several of the peer's private URLs match, it uses the first in the peer's list. Otherwise it dials the peer's `url`. The tags are compared as plain strings; Harper does not check that two nodes are really on the same network.

- **Only `wss://`.** A private URL must use TLS. Peers identify a TLS connection by its certificate, which does not depend on the address dialed.
- **Certificates do not change.** A node dialing a private address presents the same TLS server name (SNI) and checks the peer's certificate against the same name as when it dials `url`. Do not add private IP addresses to certificates.
- **Fallback.** If a private address does not connect, or the peer there does not identify as the expected node within 30 seconds, the node replicates over `url` instead. It checks the private address again on a backoff of up to five minutes, which starts over while the peer itself is down. When it answers, one connection moves back first; once that peer identifies itself, the others follow, each reconnecting once. The public port must stay reachable.
- **Changes.** A node publishes a change to its own `privateUrls` when it restarts. Its peers then reconnect to it at the new address.
- **Status.** [`cluster_status`](./clustering.md#cluster-status) reports which address each connection uses in its `path` field.

Forwarded operations, such as a replicated `deploy_component`, always use `url`.

### Data Selection

By default, Harper replicates all data in all databases. You can narrow replication to specific databases:

```yaml
replication:
  databases:
    - data
    - system
```

All tables within a replicated database are replicated by default. To exclude a specific table from replication, set `replicate: false` in the table definition:

```graphql
type LocalTableForNode @table(replicate: false) {
	id: ID!
	name: String!
}
```

Transactions are replicated atomically, which may span multiple tables. You can also control how many nodes data is replicated to using [sharding configuration](./sharding.md).

### Dedicated Replication Threads

<VersionBadge version="v5.4.0" />

When replication runs on the same worker threads that serve application requests, catching up a peer that was offline (streaming its backlog, a full copy, back-pressure handling) competes with your application for those threads. `replication.threads` starts that many additional worker threads that run replication only. It defaults to half of `threads.count`, rounded down, so a node with two or more HTTP worker threads and a dedicated replication port gets them without configuration; set it explicitly to choose the count:

```yaml
replication:
  securePort: 9933
  threads: 2
```

With dedicated replication threads:

- Only the replication threads listen on the replication port, and they own every subscription to other nodes, so both sending and receiving replication data happen off the application threads.
- The replication threads load no application code. Anything your application installs on a table at runtime is not present there, so applications that rely on it should keep `replication.threads: 0`:
  - `setResidency`: replicated writes that carry no residency list are placed by the default residency instead of by your callback.
  - `setResidencyById`: nodes outside a record's residency receive an invalidated, partial copy of it that holds the record's indexed attribute values.
  - `setComputedAttribute` on an `@indexed` computed attribute: a replication thread cannot maintain that index, so it refuses to receive the database that contains the table. It logs the table and attributes and keeps retrying, and nothing else in that database replicates to this node until `replication.threads` is set back to `0`. Computed attributes defined with `@computed(from: "...")` are not affected.
- Reads that fetch a missing record from another node still run on the thread serving the request.
- A dedicated replication port is required: set `replication.securePort` (default `9933`) or `replication.port`, different from the HTTP and operations API ports. With an explicit `replication.threads`, Harper refuses to start otherwise; with the default, it logs a warning and starts no replication threads.
- When `replication.threads` is not set and an application registers `setResidency`, `setResidencyById` or `setComputedAttribute` on an indexed attribute at startup, no replication threads start, and a warning names the tables. These hooks are deprecated in v5.4.0.
- `threads.count: 0` (no worker threads) ignores the setting.
- On macOS and Windows, which lack `SO_REUSEPORT`, only one replication thread listens on the replication port; the others carry outbound subscriptions.
- Changing the number of threads takes effect only on a full `restart` of Harper; `restart_service` does not start or stop replication threads. An unscoped `restart_service` does restart the existing replication threads, and deploying or dropping a component does not.

Schema-defined [sharding](./residency.md) runs on application, operations and dedicated replication threads; it is an alternative to the thread-local residency setters.

## Securing Connections

Harper supports PKI-based security and authorization for replication connections. Two authentication methods are supported:

- **Certificate-based authentication** (recommended for production): Nodes are identified by the certificate's common name (CN) or Subject Alternative Names (SANs).
- **IP-based authentication** (for development/testing): Nodes are identified by IP address when using insecure connections.

Harper can automatically perform CRL (Certificate Revocation List) and OCSP (Online Certificate Status Protocol) verification to ensure revoked certificates cannot be used. OCSP and CRL work automatically with certificates from public CAs when `enableRootCAs` is enabled. For self-signed certificates or private CAs without OCSP/CRL support, use Harper's manual certificate revocation feature. Certificate verification settings follow the same configuration as HTTP mTLS connections (see [Certificate Verification](../security/certificate-verification.md)).

### Providing Your Own Certificates

If you have certificates from a public or corporate CA, enable `enableRootCAs` so nodes validate against the standard root CA list:

```yaml
replication:
  enableRootCAs: true
```

Ensure the certificate's CN matches the node's hostname.

### Setting Up Custom Certificates

There are two ways to configure Harper with your own certificates:

1. Use the `add_certificate` operation to upload them.
2. Specify certificate paths directly in `harper-config.yaml`:

```yaml
tls:
  certificate: /path/to/certificate.pem
  certificateAuthority: /path/to/ca.pem
  privateKey: /path/to/privateKey.pem
```

Harper will load the provided certificates into the certificate table and use them to secure and authenticate connections. If you have a publicly-signed certificate, you can omit the `certificateAuthority` and enable `enableRootCAs` to use the bundled Mozilla CA store instead.

### Cross-Generated Certificates

Harper can generate its own certificates for secure connections — useful when no existing certificates are available. When you run `add_node` over SSL with temporary credentials, Harper automatically handles certificate generation and signing:

```json
{
	"operation": "add_node",
	"hostname": "server-two",
	"verify_tls": false,
	"authorization": {
		"username": "admin",
		"password": "password"
	}
}
```

On a fresh install, set `verify_tls: false` temporarily to accept the self-signed certificate. Harper then:

1. Creates a certificate signing request (CSR) and sends it to `server-two`.
2. `server-two` signs the CSR and returns the signed certificate and CA.
3. The signed certificate is stored for all future connections.

Credentials are not stored — they are discarded immediately after use. You can also provide credentials in HTTP Authorization format (Basic, Token, or JWT).

### Revoking Certificates

<VersionBadge version="v4.5.0" />

Certificates used in replication can be revoked using the certificate serial number. Use either the `revoked_certificates` attribute in the `hdb_nodes` system table or route config:

Via the operations API:

```json
{
	"operation": "update_node",
	"hostname": "server-two",
	"revoked_certificates": ["1769F7D6A"]
}
```

Via `harper-config.yaml`:

```yaml
replication:
  routes:
    - hostname: server-three
      port: 9930
      revokedCertificates:
        - 1769F7D6A
        - QA69C7E2S
```

### Insecure IP-Based Authentication

For development, testing, or secure private networks, you can disable TLS and use IP addresses to authenticate nodes. Configure replication on an insecure port and set up IP-based routes:

```yaml
replication:
  port: 9933
  routes:
    - 127.0.0.2
    - 127.0.0.3
```

> **Warning**: Never use insecure connections for production systems accessible from the public internet.

Loopback addresses (`127.0.0.X`) are a convenient way to run multiple nodes on a single machine for local development.

## Controlling Replication Flow

By default, Harper replicates all data in all databases with symmetric bidirectional flow. To restrict replication to one direction between certain nodes, set `sends` and `receives` on the route configuration:

```yaml
replication:
  databases:
    - data
  routes:
    - hostname: node-two
      replicates:
        sends: false
        receives: true
    - hostname: node-three
      replicates:
        sends: true
        receives: false
```

In this example, the local node only receives from `node-two` (one-way inbound) and only sends to `node-three` (one-way outbound).

### Per-database controlled flow

<VersionBadge version="v5.1.0" />

Routes have accepted per-database `sendsTo` / `receivesFrom` entries since v5.1.0, but a directional route was stored without being enforced on live connections until v5.1.15: before that, the direction gates read only the peer's advertised `hdb_nodes` record, so traffic flowed both ways regardless of what the route declared. The behavior described below is the v5.1.15-and-later behavior.

You can also scope flow per database, so different databases flow in different directions between the same two nodes. Use `sendsTo` / `receivesFrom` entries with a `database`:

```yaml
replication:
  databases:
    - cardata
    - config
    - system
  routes:
    - hostname: node-two
      replicates:
        sendsTo:
          - database: config
          - database: system # push central config (users, roles, schemas) downstream
        receivesFrom:
          - database: cardata # aggregate telemetry upstream
```

If this is `node-one`'s configuration, `node-two` needs the inverse directional route:

```yaml
replication:
  hostname: node-two
  databases:
    - cardata
    - config
    - system
  routes:
    - hostname: node-one
      replicates:
        sendsTo:
          - database: cardata
        receivesFrom:
          - database: config
          - database: system
```

Each entry can also carry `excludeTables` to keep specific tables out of a database that otherwise flows in that direction:

```yaml
replication:
  routes:
    - hostname: node-two
      replicates:
        sendsTo:
          - database: cardata
            excludeTables:
              - raw_telemetry # everything in cardata except this table
```

`sendsTo` / `receivesFrom` are declared from the perspective of the node whose `harper-config.yaml` they're in, for its route to that one peer. A route that declares `replicates` with `sends`, `receives`, `sendsTo`, or `receivesFrom` is authoritative on each side; a route without those fields — or no route at all — falls back to the peer's advertised `hdb_nodes` self-record.

The **sending** side needs the matching `sendsTo` entry when it has a directional route for that peer. To aggregate a database upstream instead of pushing it downstream — for example, so a role created on a roadside node reaches a middle-tier node — the **roadside** node's directional route to middle needs `sendsTo: [{ database: system }]`; without it, middle's subscription attempt is rejected as unauthorized. If roadside has no directional route to middle, it instead authorizes the send from middle's advertised `receivesFrom` and may serve `system` without a local `sendsTo` entry.

Likewise, the **receiving** side needs a matching `receivesFrom` only when it has its own directional route for that peer: a middle-tier node with a directional route to roadside is gated by that route, so omitting `receivesFrom` there means it never attempts the subscription. If middle has no route to roadside at all — or only a plain, non-directional one — it falls back to roadside's advertised `hdb_nodes` self-record. That self-record qualifies each `sendsTo` entry with the hostname of the route that produced it: middle subscribes because roadside's route to middle carries `database: system`, while core appears in no such route and matches no entry. On a receiver with no directional route for the peer, omitting `receivesFrom` is therefore not a way to block inbound replication.

### Replicating the `system` database with controlled flow

<VersionBadge type="changed" version="v5.2.0" />

Before v5.2, replicating the `system` database under controlled flow was discouraged: because `hdb_nodes` (the node registry) lives in `system` and each node advertised itself as a full-mesh participant, replicating `system` caused every node to discover and directly connect to every other node — collapsing a constrained topology into a full mesh.

As of v5.2 you can replicate `system` while keeping a constrained topology among nodes that all advertise directional routes. When a node has directional routes, it advertises a **directional** registry record derived from those routes (which neighbors it sends to / receives from) instead of a blanket "connect to everyone." A discovered non-neighbor with a directional registry record therefore is not subscribed to and does not receive a replication connection. This lets central configuration — users, roles, and schemas — propagate transitively across the whole cluster while user-database connections stay on the routes you configured. For example, in a `roadside → middle → core` aggregation tree, a role created on a roadside node reaches the core through the middle tier, yet the core never opens a direct replication subscription to a roadside node.

Notes and current limitations:

- This applies only when a node has **directional** routes in its `harper-config.yaml` (`replicates` with `sends`/`receives` or `sendsTo`/`receivesFrom`). A node with no directional routes keeps the legacy full-mesh advertisement — including a node scoped only through `add_node` / `set_node`, which does not produce a directional self-record (see [Add Node](./clustering.md#add-node)). A dynamically provisioned tier that replicates `system` without config routes therefore still collapses to a full mesh. `add_node` scoping is also not durable: every node rewrites its own registry row from its config routes on restart or component reload, so entries an `add_node` call wrote onto the added node's row are superseded — and a node with no directional routes re-advertises the legacy full-mesh record.
- The no-direct-connection guarantee requires every discoverable participant to advertise directional routes. A node that advertises the legacy full-mesh record can still be reached through the advertised-record fallback when a receiver has no directional route for it.
- This constrains replication subscriptions only. On-demand residency/retrieval connections (for example, sharded or invalidated-cache reads) use a separate mechanism governed by data residency, not by this registry record, and can still open a direct socket to a non-neighbor node.
- Central visibility of every node is not guaranteed: an aggregation node may not list every distant leaf in its `hdb_nodes` registry (the registry relay differs from data relay). This does not open a connection either way.
- Route changes to a node's own directionality take effect on restart.
- **Any node that receives `system` must be trusted with its contents.** The database includes encrypted `system.hdb_secret` rows, and a joined Harper Pro node holds the cluster custody key that can decrypt them, so sending `system` to a node is a disclosure decision regardless of direction. If a node is outside your confidentiality boundary, do not replicate `system` to it. `excludeTables` on the entries that carry `system` (see [Per-database controlled flow](#per-database-controlled-flow)) can keep individual tables off a node, but it is not a general substitute for that decision: a node without its own `hdb_secret` rows cannot resolve the secret references a replicated component deploy carries, so deploys that use registry or git credentials fail there.
- Within that boundary, direction is still an **integrity** control. Replicating `system` upstream (edge → core) propagates `hdb_user`/`hdb_role` along with everything else in the database: a compromised edge node can create a user or role with cluster-wide privileges or alter its advertised directionality in `hdb_nodes`, and those changes reach every node on the upstream path. To keep an edge node from writing to the cluster's identity state while still receiving it, enforce downstream-only `system` replication with directional routes on both nodes: include `system` in the central node's `sendsTo` and the edge node's `receivesFrom`, and omit it from the central node's `receivesFrom` and the edge node's `sendsTo`. A plain or absent route on either side falls back to the peer's advertised registry record and does not enforce that direction.

### Explicit Subscriptions

By default, Harper automatically manages connections and subscriptions between nodes. Explicit subscriptions exist only for testing, debugging, and legacy migration — they should not be used for production replication and will likely be removed in v5.

With explicit subscriptions, Harper no longer guarantees data consistency. If you want unidirectional replication, use [controlled replication flow](#controlling-replication-flow) instead.

To explicitly subscribe, use `add_node` with subscription definitions:

```json
{
	"operation": "add_node",
	"hostname": "server-two",
	"subscriptions": [
		{
			"database": "dev",
			"table": "my-table",
			"publish": true,
			"subscribe": false
		}
	]
}
```

Update a subscription with `update_node`:

```json
{
	"operation": "update_node",
	"hostname": "server-two",
	"subscriptions": [
		{
			"database": "dev",
			"table": "my-table",
			"publish": true,
			"subscribe": true
		}
	]
}
```

## Monitoring Replication

<VersionBadge version="v4.5.0" /> (cluster status timing statistics)

Use `cluster_status` to monitor the state of replication:

```json
{
	"operation": "cluster_status"
}
```

See [Clustering Operations](./clustering.md#cluster-status) for the full response schema and field descriptions.

## Initial Synchronization and Resynchronization

Initial synchronization is decided per peer and per database. A new node can request a full copy from each in-scope peer for which it has no resume cursor, so a join can load several peers at once. [`add_node` with `isLeader: true`](./clustering.md#add-node) identifies a bootstrap source; it does not prevent full-copy requests to other cursorless peers. After synchronization, replication continues incrementally.

If a node goes offline and comes back, it resynchronizes automatically to catch up on missed transactions. If a peer has purged history the node would need to replay, it receives a base copy instead ([when a peer forces one](#when-a-peer-forces-a-base-copy)); [`logging.auditRetention`](../logging/configuration.md#loggingauditretention) defaults to `3d`, but disk pressure can purge history sooner. A base copy sends current rows as writes without clearing tables or deleting rows, so rows deleted elsewhere remain on the receiver. Copies also run in reverse: rows from the returning node can reappear on peers whose deletion tombstones have been purged. There is no resync or reconcile operation, and neither copy completion nor subsequent replay proves that the data matches. Keep a long-absent node isolated from replication before startup, then [remove it](./clustering.md#remove-node), rebuild it with empty databases, and [add it as a new node](./clustering.md#add-node) when peers are authoritative. When it is authoritative, keep it isolated, stop every peer before rebuilding any, rebuild each peer the same way, and only then lift the isolation one peer at a time, so each copies from it. [Operating Replication](/learn/administration/operating-replication#what-moves-automatically-and-what-does-not) gives the full order.

You can also specify a `start_time` in the `add_node` operation to limit the initial download to data since a given point in time:

```json
{
	"operation": "add_node",
	"hostname": "server-two",
	"start_time": "2024-01-01T00:00:00.000Z"
}
```

### When a Peer Forces a Base Copy

<VersionBadge type="changed" version="v5.3.6" />

The peer that would send the catch-up decides, per database, when the returning node subscribes. It logs `forcing a bounded base-copy resync` when it forces a copy. Before v5.3.6, a peer forced one whenever the returning node's position was older than `logging.auditRetention` or than the peer's oldest retained entry. A peer that had written nothing to a database since then therefore forced a full copy even though nothing was missed.

From v5.3.6, a peer records how far each prune of its transaction logs reached. It forces a copy when the returning node's position, for a log it would replay, is below that point. A position that is old only because the peer wrote nothing to that database since, such as an idle or never-written transaction log, no longer forces a copy. A copy can still be forced although nothing was missed, in these cases:

- The peer has no trustworthy record of what it pruned. It then uses the pre-v5.3.6 rule.
- After [`delete_transaction_logs_before`](../database/transaction.md#delete_transaction_logs_before), a node whose position is below the point that purge reached (at most the timestamp it was given) gets a base copy, even if the peer wrote nothing to that database after that position.
- The peer has no record of what was removed from a transaction log that was already purged empty before it first ran v5.3.6 or later. After that upgrade, such a log can force one more base copy of that database for each node returning with a position older than that purge.
- On RocksDB, the storage engine also purges transaction logs on its own after three days. If the peer itself was stopped for longer than that, a node whose position is older than three days gets one base copy of the database from it.

<VersionBadge version="v5.4.0" /> A peer never forces a base copy on a node that owns [sharding](./residency.md) slots the peer is not a complete co-owner of, because that node would refuse it. The peer replays what its transaction logs still hold from the node's position instead, and logs a warning once per database, node and reason, ending `so replay continues from <position>, and writes from this node it has not received may be missing there.` Whatever the peer purged before that node received it stays missing there, including rows of tables in that database that are not sharded.

<VersionBadge version="v5.4.1" /> A peer upgraded in place from v4 on LMDB starts recording its prunes when it first runs v5.3.6 or later, so a v4 node's position from before that upgrade looks purged. A v4 node cannot take a verified copy of a table without a numeric update timestamp, including the system tables. So when the peer's retained transaction log still reaches back to that position, and the position is newer than `logging.auditRetention`, the peer replays from it instead of forcing a copy. It logs a warning once per database and node, ending `the retained log reaches back to that start and the peer cannot take an unverified copy, so replay continues from there.` A v4 node whose position falls outside retention, for example on a database with no writes after the upgrade, still gets the copy. The replay cannot see entries removed for one table only, by a v4 `deleteHistory` or by [`delete_audit_logs_before`](../database/transaction.md#delete_audit_logs_before), above that position: those changes stay missing on the v4 node.

A copy that keeps failing is reported as [`stuckCopy`](./clustering.md#stuck-copies) in `cluster_status`, and its reconnects are held back instead of retried indefinitely.

### Rows From Unnamed Origins

<VersionBadge version="v5.3.6" />

Each replicated row records its origin, the node that wrote it, as a numeric id that each node maps to a node name. A node can hold rows whose origin id has no name on that node, for example data migrated from v4, or rows from a node whose name mapping no longer exists. Before v5.3.6, a peer receiving such a row could not translate its origin, so a base copy that included it failed and restarted from the same position indefinitely.

From v5.3.6, the sending node names that origin `unnamed-origin-<id>@<node name>`, where `<id>` is its origin id on the sending node and `<node name>` is the sending node's own name. Receivers treat it like any other origin. A node on v5.3.6 or later receiving from an older node derives the same name itself and logs a warning: `<node name> sent <database> records from origin id <id>, which has no name there; applying them as origin unnamed-origin-<id>@<node name>`. It derives at most 64 new names per connection; past that, the connection closes and reconnects.

In `<node name>`, each character other than ASCII letters, digits, `.` and `-` becomes `_` followed by its four-digit lowercase hexadecimal code, so `:` becomes `_003a` and `_` becomes `_005f`. These names identify where rows came from; no node by that name exists. They can appear in log lines on any node that receives or relays those rows.

## Replicated Transactions

The following data operations are replicated across the cluster:

- Insert
- Update
- Upsert
- Delete
- Bulk loads (CSV data load, CSV file load, CSV URL load, import from S3)

**Destructive schema operations differ from each other, so check before you run one:**

- `drop_database` and `drop_table` **replicate to the whole cluster by default** on Pro and Fabric. Pass `"replicated": false` to drop on one node only.
- `drop_attribute` is not replicated and must be run on each node independently.

Data mutations, `drop_database`, `drop_table`, and component deployment replicate by default on Pro and Fabric; pass `"replicated": false` to limit them to one node. [`set_configuration`](../configuration/operations.md#set-configuration) and [`restart_service`](../operations-api/operations.md#restart_service) are opt-in: pass `"replicated": true` for a cluster-wide configuration update or rolling restart.

Users and roles **do** propagate by default. They live in the `system` database, and the default replication scope is every database, so `system` is in scope unless you have narrowed it. As of v5.2 replicating `system` no longer forces a full mesh — see [Replicating the `system` database with controlled flow](#replicating-the-system-database-with-controlled-flow). If you narrow the scope to exclude `system`, users and roles stop propagating and must be provisioned on every node by your own automation.

Check each management operation's replication default before using it in a single-node procedure.

## Cluster Record Locks

On a replicated table, `lock()` without `{ scope: 'node' }` takes a cluster-wide lock: while one node holds it, no other node's `lock()` on that record succeeds. From v5.4.0, with cluster record locks on, conditional REST writes (a `PUT`, `PATCH` or `DELETE` with `If-Match`, `If-None-Match` or `If-Unmodified-Since`) take the same lock while `rest.preconditionLocks` is on, its default. A table declared with `replicate: false` takes a node-local lock instead.

Cluster record locks are off unless you turn them on. While they are off, a cluster `lock()` on a replicated table answers `503` with a message naming the fix, and `{ scope: 'node' }` still takes a node-local lock. Conditional writes do not take a lock: they check their precondition against this node's copy of the record, as in v5.3, so a matching `If-Match` succeeds and a stale one answers `412`. Two requests that saw the same ETag can then both succeed, on one node or on two. With cluster record locks on, conditional writes are checked one at a time per record, which is stronger but still has [limits](../rest/headers.md#conditional-writes); unconditional writes are never excluded, and a conditional write on a node that has them off is not serialized against writes on nodes that have them on, so set the key on every node before relying on them.

**On Harper Fabric**, Fabric turns cluster record locks on for a cluster and publishes its home map; you do not configure them.

**On a self-hosted cluster**, turn them on in two steps:

1. Set [`replication.recordLocks: true`](../configuration/options.md#replication) on every node and restart each one. Every node of a database must have the same setting.
2. Apply a home map, the list of nodes that arbitrate a database's locks, once per replicated database. Run it on any node, naming every node that replicates the database:

   ```json
   {
   	"operation": "record_lock_apply_homes",
   	"database": "data",
   	"homes": ["node-1", "node-2", "node-3"]
   }
   ```

   `record_lock_propose_homes` with `{"database": "data"}` returns the list this node sees, which you can pass straight in. The call answers `outcome: "activated"` once every named node has the map. The other outcomes fail closed:

   - `refused`: nothing was written, for example because a named node did not answer. Fix the cause and repeat the call.
   - `incomplete`: a node did not finish staging or activating, so some nodes refuse locks. Repeat the same call.
   - `staged`: every node stopped granting, but one could not prove it holds no locks. Wait `retryAfterMs`, then repeat the call with the `generation` it returned and `"drained": true`.

Between the two steps, a cluster `lock()` and a conditional write wait up to 10 seconds within their timeout and then answer `503`, so apply the map right after the restarts.

The home map changes only when an operator applies a new one, so apply one after membership changes:

- **A node added later** answers every cluster `lock()` and conditional write with `503` until a map that includes it is applied. The other nodes keep locking.
- **A removed node** stays in the map, and `remove_node` makes the other nodes stop trusting it, so every cluster `lock()` and conditional write on the database answers `503` until a map without it is applied. Apply a map without it before running `remove_node`, while the node is still reachable, with `quiesce` listing the old map's nodes and the new ones, so the departing node stops granting too. A node that is already unreachable can be left out only by naming it in `fenced`, which attests that it is stopped and needs a majority of the old map's nodes to answer; if the call is refused, its `reason` names the per-node steps that recover.

<VersionBadge version="v5.5.0" /> **After the operating system restarts** (an OS crash, power loss or reboot), a node may have lost its most recent commits even though peers confirmed them, so it asks each peer for the writes it originated and applies the ones it is missing. Until every peer that replicates the database with it, and every node in the home map, has answered, a lock on that node that depends on its writes from before the restart (including the first lock on a key whose home node also restarted) waits within its timeout and then answers `503`. A peer that is stopped, or that runs a version without this recovery, therefore keeps such locks at `503` until it is back or upgraded.

A restart of Harper alone (a deploy, a crash or an out-of-memory kill with the OS still running) loses nothing, so it skips this. The node tells the two apart by the OS boot identity on Linux and macOS; on other platforms every start recovers, and so does the first start after upgrading to this version. A failed transaction-log sync also makes the next start recover.

Cluster record locks need the RocksDB storage engine. On LMDB `lock()` is not available, and conditional writes do not take a lock.

<VersionBadge version="v5.4.1" />

What counts is the engine each database is opened on, not `storage.engine`. That setting only picks the engine for databases created from then on, so a node upgraded in place from v4 keeps its existing `.mdb` databases on LMDB. If any database the node replicates is opened on LMDB, including `system`, which `replication.databases: '*'` (the default) replicates, the node starts with cluster record locks off even with `recordLocks: true`. It logs an error naming those databases, peers see it as not taking part, and a cluster `lock()` answers `503` saying that replicated databases are on LMDB. Migrate them with `storage.migrateOnStart` and restart. `describe_all` and `describe_table` report each table's `engine` (`rocksdb` or `lmdb`), so a tool can check a node before turning locks on.

### Confirming Locked Writes

<VersionBadge version="v5.5.0" />

With cluster record locks on, a commit made under a cluster lock waits for one peer to confirm it. RocksDB commits do not wait for the local disk, so without that wait a holder whose node loses power before the write reaches a peer could lose the write, and once that node restarts the next holder could be admitted without it. [`replication.recordLockConfirmation`](../configuration/options.md#replication) sets the count:

```yaml
replication:
  recordLocks: true
  recordLockConfirmation: 1 # the default while recordLocks is true; 0 commits locked writes without waiting
```

- **When it applies:** a commit waits when its transaction holds a cluster lock on a table in the database it writes, or writes through a held lock (`hold: true`). A lock in one database doesn't make writes to another database wait. A node-scoped lock never does, and neither do writes made without a lock.
- **How many:** at least this many peers, or the write's own count if that is larger (including the [`replication.confirmation`](./sharding.md#default-confirmation-count) default). An explicit `0` doesn't lower it.
- **No peer connected:** when this node is not sending the database to enough connected peers, the commit is refused with `503` before anything is written, and the lock is released. Retry once a peer reconnects. A node that replicates the database to fewer peers than the count, a single-node cluster included, refuses it with `400`; set `recordLockConfirmation: 0` there.
- **A peer drops during the wait:** the wait ends once the peers that could confirm it have been gone for `pingTimeout`, or at `confirmationTimeout` at the latest. A peer counts as gone when its connection closes, or after `pingTimeout` with nothing heard from it, so the wait ends within about twice `pingTimeout` of the drop (about 2 minutes by default). The `504` says the write committed on this node but was not confirmed.
- **An explicit count that meets the minimum** (`X-Replicate-To: *;confirm=<k>` or `replicatedConfirmation`) keeps its own rules: it is [refused or timed out](./sharding.md#replication-control-via-rest-header) as without locks, and waits up to `confirmationTimeout` while its peers are down.
- **The lock is not held longer:** it is released when the commit lands on this node, before the wait.
- **When confirmation fails,** the error carries `replicationUnconfirmed: true` and `retryable: false` ([details](./sharding.md#confirmation-failure-after-a-local-commit)). The write is committed on this node. A transaction's lock is already released, so the next holder can have it and may already see the write. A `hold: true` lock stays held until `unlock()` or its lease either way.
- **Limits:** confirmation means a peer acknowledged applying this node's log up to a key at or past the write's. Concurrent commits can reach the log out of key order, so a write can count as confirmed while still in flight when the peer has already acknowledged a newer write that was logged first. It is not a quorum: in a cluster of three or more, the next holder can be admitted through a peer that did not confirm. A power loss between the local commit and the acknowledgment can still lose the write, and the caller then sees no success.
- **Cost:** each locked commit waits one replication round trip.
- The value is read at startup, so restart a node after changing it.

## Inspecting Cluster Configuration

Query the `hdb_nodes` system table to inspect the current known nodes and their configuration:

```json
{
	"operation": "search_by_value",
	"database": "system",
	"table": "hdb_nodes",
	"attribute": "name",
	"value": "*"
}
```

The `hdb_certificate` table contains the certificates used for replication connections.

## See Also

- [Clustering Operations](./clustering.md) — Operations API for managing cluster nodes and subscriptions
- [Sharding](./sharding.md) — Distributing data across a subset of nodes
- [Certificate Management](../security/certificate-management.md)
