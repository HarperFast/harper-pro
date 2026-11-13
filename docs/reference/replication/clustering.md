---
title: Clustering
sidebar_position: 20
sidebar_label: 'Clustering'
---

<!-- Source: versioned_docs/version-4.7/developers/operations-api/clustering.md (primary) -->
<!-- Source: release-notes/v4-tucker/4.5.0.md (confirmed cluster status timing statistics in v4.5.0) -->

# Clustering

Operations API for managing Harper's replication system. For an overview of how replication works, see [Replication Overview](./overview.md). For sharding configuration, see [Sharding](./sharding.md).

All clustering operations require `super_user` role.

---

### Add Node

Adds a new Harper instance to the cluster. If `subscriptions` are provided, it creates the specified replication relationships between the nodes. Without `subscriptions` or `sendsTo` / `receivesFrom`, a fully replicating system is created (all data in all databases). `sendsTo` / `receivesFrom` instead scope controlled-flow replication to the databases they name.

**Parameters**:

- `operation` _(required)_ — must be `add_node`
- `hostname` or `url` _(required)_ — the hostname or URL of the node to add
- `verify_tls` _(optional)_ — whether to verify the TLS certificate. Set to `false` temporarily on fresh installs with self-signed certificates. Defaults to `true`
- `authorization` _(optional)_ — credentials for the node being added. Either an object with `username` and `password`, or an HTTP `Authorization` style string
- `retain_authorization` _(optional)_ — if `true`, stores credentials and uses them on every reconnect. Generally not recommended; prefer certificate-based authentication. Defaults to `false`
- `revoked_certificates` _(optional)_ — array of revoked certificate serial numbers that will not be accepted for any connections
- `shard` _(optional)_ — shard number for this node. Only needed when using sharding
- `start_time` _(optional)_ — ISO 8601 UTC datetime. If set, only data after this time is downloaded during initial synchronization instead of the entire database
- `isLeader` _(optional)_ — identify the added node as a bootstrap source for this node. This does not grant primary ownership or write authority, or prevent full-copy requests to other peers for which this node has no resume cursor. Subsequent replication still follows the configured routes
- `subscriptions` _(optional)_ — explicit table-level replication relationships. This is optional (and discouraged). Each subscription is an object with:
  - `database` — database name
  - `table` — table name
  - `subscribe` — if `true`, transactions on the remote table are replicated locally
  - `publish` — if `true`, transactions on the local table are replicated to the remote node
- `sendsTo` / `receivesFrom` _(optional)_ <VersionBadge version="v5.1.0" /> <VersionBadge type="changed" version="v5.2.0" /> — database-scoped controlled-flow entries for this node (see [Controlling Replication Flow](./overview.md#controlling-replication-flow)). Each entry is an object `{ database?, excludeTables? }`, or (less usefully) a bare string naming a peer, intended to authorize all databases for that peer rather than match a database name. An entry can also carry a `target` (on `sendsTo`) or `source` (on `receivesFrom`) naming the one peer it applies to; an entry with neither matches any peer. **Only the peer-agnostic object form — `{ database?, excludeTables? }`, with no `target`/`source` — is reliable today.** Harper's reciprocal `add_node_back` registration to the added peer carries the array over without rewriting each entry's peer reference for the new direction, so a bare string or a `target`/`source` value that's correct for your side of the connection ends up wrong on the peer's copy, and the peer's send-authority check silently rejects the subscription — replication doesn't happen ([harper-pro#710 - `add_node_back` does not rewrite peer-qualified `sendsTo`/`receivesFrom` entries](https://github.com/HarperFast/harper-pro/issues/710)). Use [config routes](./overview.md#controlling-replication-flow) for anything that needs to be scoped to one peer. Unlike a config route's `replicates.sendsTo` / `replicates.receivesFrom`, which describes the _local_ node's own direction, these describe the **added node's** perspective: `sendsTo` lists what the added node sends (what this node receives from it), and `receivesFrom` lists what the added node receives (what this node sends to it). If both `subscriptions` and `sendsTo`/`receivesFrom` are provided, `subscriptions` takes precedence and `sendsTo`/`receivesFrom` are ignored. To replicate all databases while excluding specific tables, use a wildcard entry (`excludeTables` with no `database`).

  > **Note**: Because these entries aren't scoped to one peer, the resulting `hdb_nodes` record for the added node isn't restricted to the connection that created it — any other node that also holds the listed database(s) can match against it too. This also doesn't change how the local node advertises itself to the rest of the cluster: a node's own directional (non-mesh) `hdb_nodes` self-record is derived solely from its `harper-config.yaml` routes, so replicating `system` without collapsing to a full mesh requires directional routes in config, not just `add_node`/`set_node` scoping (see [Replicating the `system` database with controlled flow](./overview.md#replicating-the-system-database-with-controlled-flow)). Nor is the scoping durable: each node rewrites its own `hdb_nodes` row from its `harper-config.yaml` routes when it restarts or reloads components, and that row replicates, so directional entries an `add_node` call wrote onto the added node's row are superseded — a node with no directional routes goes back to advertising the legacy full-mesh record. Use config routes for any constraint that has to survive a restart or a `deploy_component` reload.

  > **Changed in v5.2**: these parameters have been accepted since v5.1.0, but they only gate replication as described above from v5.2 on. Before v5.2, `add_node` wrote a blanket "sends everything" flag onto the added node's registry record alongside the entries, which authorized this node to receive every database from that node and left `sendsTo`'s `database` scoping inert; in the other direction, the send-authority check honored a `receivesFrom` entry only when it named both this node and the database, so the peer-agnostic object form recommended above did not authorize sending. As of v5.2 the blanket flag is gone — replication from the added node is limited to the databases its `sendsTo` entries name — and an entry that omits the peer or the database is treated as a wildcard by both checks. If you already call `add_node` / `set_node` with `sendsTo` / `receivesFrom`, re-check that scoping before upgrading — it can change in either direction. Databases that were replicating only because of the blanket flag stop replicating on v5.2; conversely, a peer-agnostic `receivesFrom` entry that v5.1's send check ignored becomes an active wildcard on v5.2, so it newly authorizes any peer that subscribes for the database it names.

**Request**:

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

**Request** (controlled flow, scoped per database):

```json
{
	"operation": "add_node",
	"hostname": "server-two",
	"sendsTo": [{ "database": "cardata", "excludeTables": ["raw_telemetry"] }],
	"receivesFrom": [{ "database": "config" }, { "database": "system" }]
}
```

Read from the added node's perspective: `server-two` sends `cardata` (except `raw_telemetry`) to this node, and receives `config` and `system` from it.

**Response**:

```json
{
	"message": "Successfully added 'server-two' to cluster"
}
```

> **Note**: `set_node` is an alias for `add_node`.

---

### Update Node

Modifies an existing Harper instance in the cluster. Will attempt to add the node if it does not exist.

**Parameters**:

- `operation` _(required)_ — must be `update_node`
- `hostname` _(required)_ — hostname of the remote node to update
- `revoked_certificates` _(optional)_ — array of revoked certificate serial numbers rejected when a new connection authenticates (already-open connections are not closed)
- `shard` _(optional)_ — shard number to assign to this node. On the responding node's own hostname it must equal that node's `replication.shard`; any other value returns 400, since the node's own record follows its configuration. Change `replication.shard` and restart instead. Setting a peer's `shard` to a value other than its `replication.shard` leaves that peer `held` (refusing sharded writes) until its `replication.shard` matches, and restarting the peer beforehand rewrites its record from `replication.shard`.
- `subscriptions` _(optional)_ — array of subscription objects (same structure as `add_node`)
- `sendsTo` / `receivesFrom` _(optional)_ — same structure and directional meaning as in [Add Node](#add-node) above: they describe the `hostname` node's perspective, not this node's. See Add Node for the v5.1/v5.2 gating history and the `add_node_back` peer-rewrite caveat. As with Add Node, if both `subscriptions` and `sendsTo`/`receivesFrom` are provided, `subscriptions` takes precedence and `sendsTo`/`receivesFrom` are ignored.

**Request**:

```json
{
	"operation": "update_node",
	"hostname": "server-two"
}
```

A request for an existing `hostname` record that carries `revoked_certificates` and/or `shard` and none of `url`, `isLeader`, `retain_authorization`, `start_time`, `force_signing`, `subscriptions`, `sendsTo` or `receivesFrom` is written to this node's record of `hostname` without contacting it, and replicates to the cluster from there. Any other request, including one for a `hostname` with no local record yet, runs the full `add_node` exchange with that node.

**Response**:

```json
{
	"message": "Successfully updated 'server-two'"
}
```

---

### Remove Node

Removes a Harper node from the cluster and stops all replication to and from that node. Run it on any member, naming the node to remove.

<VersionBadge type="changed" version="v5.5.0" />

A node accepts writes locally and sends them to its peers afterward, so a live node can hold writes no peer has received yet: writes accepted just before removal, while a peer link was down, or, for a sharded table, writes to records it does not own. `remove_node` does not delete the node's membership until those writes are on its peers:

1. The node being removed stops accepting local writes. A write to it returns `503` ("This node is being removed from its cluster"). Transactions it already started commit. This fence is persisted, so the node stays fenced across a restart. Writes it receives from peers still apply. The `system` database is not fenced.
2. `remove_node` waits until every peer the node sends a database to reports that it has committed all of the node's writes to that database. A peer that does not subscribe to the database from the node says so and is not waited for. A database the node sends to no peer (configured local-only) is not drained. For a sharded database, a peer on another shard reports the records it owns. Each peer confirms with the next delivery checkpoint the node sends it, every 30 seconds, so even a node with nothing left to send takes up to 30 seconds to remove.
3. Then the node's membership is deleted, as before. The removed node accepts local writes again once it receives the removal notice, or when it is added to a cluster again with `add_node`.

The wait has a limit (`timeout`, five minutes by default). When it runs out, the removal fails with `504` and names each peer that has not confirmed. The node stays fenced and stays a member until the removal completes or is cancelled. An `add_node` or `set_node` run on the node, or naming it from another node, also lifts a fence that was not finalized. Run `remove_node` again to resume the wait, or cancel the removal with `cancel: true`, which lets the node accept writes again.

`remove_node` refuses a live removal without `force` when:

- the node cannot be reached (it keeps retrying until `timeout`, since a restarting node is briefly unreachable),
- the node runs a version that cannot fence its writes,
- the node is the only owner of a shard in a database's [shard map](./residency.md#installed-maps), so its records exist nowhere else,
- a database is stored on LMDB, which keeps no origin floors to confirm delivery with,
- a database keeps its tables in more than one storage root (per-table `path`), or
- no peer the node sends a database to subscribes to it, or, for a sharded database, no owner of one of its shards receives it from the node, so some of its writes exist only on that node (the node accepts local writes again when this is refused).

`force: true` removes the node without fencing or waiting. Writes that only that node held are lost. Use it for a node that is permanently down.

**Parameters**:

- `operation` _(required)_ — must be `remove_node`
- `hostname` _(required)_ — hostname of the node to remove
- `timeout` _(optional)_ <VersionBadge version="v5.5.0" /> — milliseconds to wait for the node's writes to reach its peers; default `300000`
- `force` _(optional)_ <VersionBadge version="v5.5.0" /> — remove without fencing the node or waiting; writes only it holds may be lost
- `cancel` _(optional)_ <VersionBadge version="v5.5.0" /> — stop a removal that timed out: the node accepts local writes again and stays a member. Refused once the removal has been finalized, just before the membership is deleted; then run `remove_node` again to complete it. If a removal completed but the removed node never received its notice (it was unreachable), it keeps refusing local writes: run `remove_node_fence` on that node with `node` set to its own name, `cancel: true` and `force: true`.

**Request**:

```json
{
	"operation": "remove_node",
	"hostname": "server-two"
}
```

**Response**:

```json
{
	"message": "Successfully removed 'server-two' from cluster; its writes reached 2 peers before it was removed"
}
```

Two operations carry the removal between nodes, authorized for cluster nodes and super users: `remove_node_fence` runs on the node being removed (fence, finalize or cancel), and `get_received_origin_floors` runs on each peer and reports what it has received from the node. `remove_node` calls them; you do not need to.

---

### Cluster Status

Returns an array of status objects from the cluster, including active WebSocket connections and replication timing statistics.

<VersionBadge version="v4.4.0" /> ; timing statistics added in v4.5.0

**Parameters**:

- `operation` _(required)_ — must be `cluster_status`

**Request**:

```json
{
	"operation": "cluster_status"
}
```

**Response**:

```json
{
	"type": "cluster-status",
	"connections": [
		{
			"replicateByDefault": true,
			"replicates": true,
			"url": "wss://server-2.domain.com:9933",
			"name": "server-2.domain.com",
			"subscriptions": null,
			"database_sockets": [
				{
					"database": "data",
					"connected": true,
					"latency": 0.7,
					"threadId": 1,
					"nodes": ["server-2.domain.com"],
					"lastCommitConfirmed": "Wed, 12 Feb 2025 19:09:34 GMT",
					"lastReceivedRemoteTime": "Wed, 12 Feb 2025 16:49:29 GMT",
					"lastReceivedLocalTime": "Wed, 12 Feb 2025 16:50:59 GMT",
					"sendingMessage": "Wed, 12 Feb 2025 16:50:59 GMT"
				}
			]
		}
	],
	"node_name": "server-1.domain.com",
	"is_enabled": true,
	"sharding": {}
}
```

`database_sockets` shows the actual WebSocket connections between nodes — one socket per database per node. Timing fields:

| Field                    | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lastCommitConfirmed`    | Last time a receipt of confirmation was received for an outgoing commit                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `lastReceivedRemoteTime` | Timestamp (from the originating node) of the last received transaction                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `lastReceivedLocalTime`  | Local time when the last transaction was received. A gap between this and `lastReceivedRemoteTime` suggests the node is catching up                                                                                                                                                                                                                                                                                                                                                                                      |
| `sendingMessage`         | Timestamp of the transaction actively being sent. Absent when waiting for the next transaction                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `path`                   | Which address this node dialed for the connection: `public` (the peer's `url`), `private` (a [private network address](./overview.md#private-network-addresses)), or `public-fallback` (the peer has a private address on this node's network, but it is not connecting). Each worker thread notices an outage and recovers on its own, so sockets to one peer that different threads handle can differ for the length of an outage. Absent while disconnected or before the peer has identified itself. Added in v5.4.0 |

While a database is taking its initial full copy, these timing fields hold the literal string `"Copying"` rather than a timestamp. Anything that parses them as dates needs to handle that value, since a node taking a full copy is exactly the node you are most likely to be watching.

### Stuck Copies

<VersionBadge version="v5.3.6" />

A `database_sockets` entry has a `stuckCopy` object while a [base copy](./overview.md#initial-synchronization-and-resynchronization) of that database from that peer is not finishing. Otherwise the field is absent. The node receiving the copy reports it, on its socket to the source. Copies also run in reverse, so that can be a peer of the node that came back rather than the node itself. Run `cluster_status` on every node.

On the 5.3 line, `state` is only `retrying` or `held`. The `refused` state and everything below about refusals need [schema-defined sharding](./residency.md), which starts in v5.4.0.

```json
{
	"database": "data",
	"connected": false,
	"stuckCopy": {
		"state": "held",
		"reason": "the copy made no durable progress from its start position",
		"count": 5,
		"since": "2026-11-03T14:20:11.204Z",
		"retryAt": "2026-11-03T14:21:11.204Z"
	}
}
```

| Field     | Description                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `state`   | `retrying`, `held` or, from v5.4.0, `refused` (below)                                                                                                        |
| `reason`  | `the copy made no durable progress from its start position` for `retrying` and `held`. For `refused`, the sharding rule that refused the copy                |
| `count`   | For `retrying` and `held`, how many times a copy has started from the same position. For `refused`, how many times in a row the copy was refused             |
| `since`   | When the socket entered its current state. Another attempt or hold in the same state does not change it                                                      |
| `retryAt` | When the socket reconnects after a hold. Present only while it waits out the hold, so it is absent once the reconnect opens, even if `state` is still `held` |

`since` and `retryAt` are ISO 8601 strings, unlike the GMT strings in the timing fields above.

The states:

- **`retrying`**: a copy from this peer has started at least twice from the same position, with no durable progress in between. Reconnects follow the normal schedule.
- **`held`**: the session that made the fifth start from one position has closed. This node stops reconnecting that database to that peer for a while. Nothing in that database replicates from the peer during the hold, and the peer's copy stops too. The first hold lasts 60 seconds. After that, each reconnect makes one attempt. If it fails from the same position, the next hold is a random time between 60 seconds and a limit that doubles each time (2, 4, 8 minutes), up to 15 minutes.
- **`refused`** <VersionBadge version="v5.4.0" />: this node refused the copy under its [sharding](./residency.md#recovery-sources) rules. With the reason `Owned sharding slots require a complete co-owner or backup restore`, this node owns slots and the peer cannot supply them. Typically the peer is not a complete co-owner, so make one reachable or restore a complete backup. Reconnects are held on the same schedule as `held`. While every owner of a key refuses that peer, the peer answers a write to that key with `503` instead of accepting a write no owner would receive; the peer forgets the refusal when it restarts. With the reason `a sharded origin requires its origin or a complete co-owner`, the copy carried rows from a sharded origin that only that origin or a complete co-owner may send. Reconnects follow the normal schedule, because this usually follows a sharding map change.

The attempt limit, the hold bounds and the 60-second quiet period below are fixed. No setting changes them.

`stuckCopy` disappears in these cases:

- The copy makes durable progress, continues from a different position, or finishes. This also starts the hold schedule over.
- A later connection to the peer stays open for 60 seconds without starting or refusing a copy. This clears only the report. The start count and the hold limit stay, so if a copy later fails from the same position again, the socket shows `retrying` with the count carried on, and the next hold follows the schedule from where it left off.
- A `refused` socket settles when the session of a later, accepted copy closes. It clears, or becomes `retrying` if that copy also started twice from one position.

A missing `stuckCopy` does not show that a copy finished or that the two nodes hold the same data.

Each change of state, or of the refusal reason, logs one line beginning `Replication of <database> from <node>:`. The level is `error` when the socket is held, `warn` when it starts retrying or is refused, and `info` when the report clears, such as `copy is progressing again`. A held socket logs, for example, `copy stopped after 5 attempts from one position; retrying in 60s: the copy made no durable progress from its start position`. Further attempts or holds in the same state log nothing more.

---

### Sharding Status

<VersionBadge version="v5.4.0" />

The top-level `cluster_status.sharding` field is keyed by database and describes active or attempted declarative tables. It is empty in the legacy-table example above. Each entry has:

| Field                | Meaning                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`, `digest`  | Installed map identity; absent if no map is installed.                                                                                                                                                                                                                                                                                    |
| `shards`             | One entry per shard in the installed map, ordered by `shard`: `slots` is the number of the map's slots the shard holds, and `owners` lists the names of the nodes assigned to it, in name order. A shard with no assigned node has `owners: []`. Absent if no map is installed.                                                           |
| `nodesOwningNoSlots` | Names of cluster members, this node included, that own no slot of the installed map: nodes with no shard, or in a shard the map does not contain. Present with `shards`, as `[]` when there are none.                                                                                                                                     |
| `shardsDigest`       | Digest of the configured shard set, or `null` when no list is configured.                                                                                                                                                                                                                                                                 |
| `blocked`            | Whether a configuration/map error or a recovery phase other than `ready` blocks placement.                                                                                                                                                                                                                                                |
| `state`              | `quarantined` for a startup quarantine, `held` for a live configuration/map error, the current `recovery.phase` while recovery is incomplete, or `available`.                                                                                                                                                                             |
| `restartRequired`    | `true` for startup quarantine: repair the configuration and restart the full process. `false` does not mean recovery is complete.                                                                                                                                                                                                         |
| `recovery`           | Bootstrap/recovery phase and reason, including a missing existing-owner completeness assertion in `recovery.reason`. `origin-history-lost` refuses a reused name without its audit; restore a complete backup or rejoin with a fresh root under a new node name.                                                                          |
| `waitingOrigins`     | Origins waiting for a direct source or certified same-shard relay, with the missing source described.                                                                                                                                                                                                                                     |
| `errors`             | Reasons, such as differing peer lists, a local shard outside its list, a missing required list/map, a refused peer map, or `local shard membership disagrees with replication.shard` when this node's own record and its `replication.shard` setting disagree about a shard in the installed map, so write admission refuses those slots. |

`shards` and `nodesOwningNoSlots` come from the installed map and the shard each node's record in the cluster membership table publishes, the same view that routes writes. The responding node does not read its own `replication.shard` setting to decide ownership, so with no installed map no owners are reported. They describe what this node sees. A listed owner can still be disconnected or refuse writes, for example when its record's shard differs from its own `replication.shard` setting (that node reports it in its own `errors`), and `recovery` and `waitingOrigins` track recovery agreement separately, so read them together. A node that has just joined can be missing from both lists until its record reaches the responding node.

```json
"sharding": {
	"data": {
		"version": 1,
		"digest": "5f0c...",
		"state": "available",
		"errors": [],
		"shards": [
			{ "shard": 0, "slots": 5, "owners": ["server-1.domain.com", "server-2.domain.com"] },
			{ "shard": 1, "slots": 5, "owners": ["server-3.domain.com"] }
		],
		"nodesOwningNoSlots": ["server-4.domain.com"]
	}
}
```

The top-level `shard` of the response is the responding node's own shard, including `0`. It is absent when the node has no shard.

A clear status is not proof that an owner is connected; write admission also checks the required replication route. See [configuration agreement](./sharding.md#complete-shard-id-set) and [map recovery](./residency.md#installed-maps).

### Shard map operations

The POST operations [`initialize_shard_map`](./residency.md#installed-maps) and [`verify_shard_map`](./residency.md#3-compare-placement-on-every-node) require `super_user`. The former installs a snapshot without moving records; the latter compares the actual legacy function against a proposed key policy without modifying data. Their request examples, parameters and result fields are in the linked procedures.

---

### Configure Cluster

Bulk creates or resets subscriptions for any number of remote nodes. **Resets and replaces any existing clustering setup.**

**Parameters**:

- `operation` _(required)_ — must be `configure_cluster`
- `connections` _(required)_ — array of node objects following the `add_node` schema

**Request**:

```json
{
	"operation": "configure_cluster",
	"connections": [
		{
			"hostname": "server-two",
			"verify_tls": false,
			"authorization": {
				"username": "admin",
				"password": "password2"
			}
		},
		{
			"hostname": "server-three",
			"verify_tls": false,
			"authorization": {
				"username": "admin",
				"password": "password3"
			}
		}
	]
}
```

**Response**:

```json
{
	"message": "Cluster successfully configured."
}
```

---

### Cluster Set Routes

Adds routes to the `replication.routes` configuration. Behaves as a PATCH/upsert — adds new routes while leaving existing routes untouched.

**Parameters**:

- `operation` _(required)_ — must be `cluster_set_routes`
- `routes` _(required)_ — array of route strings (`wss://host:port`) or objects with `hostname` and `port` properties

**Request**:

```json
{
	"operation": "cluster_set_routes",
	"routes": [
		"wss://server-two:9925",
		{
			"hostname": "server-three",
			"port": 9930
		}
	]
}
```

**Response**:

```json
{
	"message": "cluster routes successfully set",
	"set": ["wss://server-two:9925", { "hostname": "server-three", "port": 9930 }],
	"skipped": []
}
```

---

### Cluster Get Routes

Returns the replication routes from the Harper config file.

**Parameters**:

- `operation` _(required)_ — must be `cluster_get_routes`

**Request**:

```json
{
	"operation": "cluster_get_routes"
}
```

**Response**:

```json
["wss://server-two:9925", { "hostname": "server-three", "port": 9930 }]
```

---

### Cluster Delete Routes

Removes routes from the Harper config file.

**Parameters**:

- `operation` _(required)_ — must be `cluster_delete_routes`
- `routes` _(required)_ — array of route objects to remove

**Request**:

```json
{
	"operation": "cluster_delete_routes",
	"routes": [
		{
			"hostname": "server-three",
			"port": 9930
		}
	]
}
```

**Response**:

```json
{
	"message": "cluster routes successfully deleted",
	"deleted": [{ "hostname": "server-three", "port": 9930 }],
	"skipped": []
}
```
