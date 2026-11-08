## Replication & Clustering

Operations for configuring and managing Harper cluster replication.

Detailed documentation: [Replication & Clustering](../replication/clustering.md)

| Operation              | Description                                                      | Role Required |
| ---------------------- | ---------------------------------------------------------------- | ------------- |
| `add_node`             | Adds a Harper instance to the cluster                            | super_user    |
| `update_node`          | Modifies an existing node's subscriptions                        | super_user    |
| `remove_node`          | Removes a node from the cluster                                  | super_user    |
| `initialize_shard_map` | Installs a custom database slot map without moving records       | super_user    |
| `verify_shard_map`     | Compares a legacy placement function with a proposed slot policy | super_user    |
| `cluster_status`       | Returns current cluster connection status                        | super_user    |
| `configure_cluster`    | Bulk-creates/resets cluster subscriptions across multiple nodes  | super_user    |

### `add_node`

Adds a remote Harper node to the cluster. If `subscriptions` are not provided, a fully replicating cluster is created. Optional fields: `verify_tls`, `authorization`, `retain_authorization`, `revoked_certificates`, `shard`.

```json
{
	"operation": "add_node",
	"hostname": "server-two",
	"verify_tls": false,
	"authorization": { "username": "admin", "password": "password" }
}
```

### `initialize_shard_map`

<VersionBadge version="v5.4.0" />

POST; requires `super_user` and a RocksDB database. Takes `database`, `slots` and complete nonoverlapping `ranges` (`start`, exclusive `end`, `shard`). Returns the installed versioned snapshot. Installs metadata only and refuses changes to active slot assignments. See [Installed maps](../replication/residency.md#installed-maps).

For a legacy conversion, call with `database`, `existing_owner: true` and `expected_digest` instead. This records the operator's assertion that this local owning node has complete bodies for its slots; Harper does not verify completeness. It requires an already-installed map with exactly that digest, rejects `slots` or `ranges` in the same call, and does not declare a sharded table. The receipt is local to the captured root generations and tables. Assert on each owning node, with legacy writers paused until activation is ready throughout the cluster. See [Converting an existing table](../replication/residency.md#convert-an-existing-by-id-table-without-moving-records).

### `verify_shard_map`

<VersionBadge version="v5.4.0" />

POST; requires `super_user`. Takes `database`, `table` and a proposed key-derived `policy` (`slots`). The existing application worker must still run its legacy function, and a custom map must be installed. Returns `checked`, `mismatches`, bounded samples, observed slots, departed node names (stored legacy owners absent from the current known-node list) and map identity. It neither rewrites records nor activates the policy. See [Compare placement](../replication/residency.md#3-compare-placement-on-every-node).

### `cluster_status`

Returns connection state for all cluster nodes, including per-database socket status and replication timing statistics (`lastCommitConfirmed`, `lastReceivedRemoteTime`, `lastReceivedLocalTime`). A socket whose base copy is not finishing also carries `stuckCopy`; see [Stuck Copies](../replication/clustering.md#stuck-copies). Its top-level `sharding` object reports per-database map identity, placement blockers and, from v5.4.0, each shard's slot count and owners plus the nodes that own no slot; see [Sharding Status](../replication/clustering.md#sharding-status).

```json
{ "operation": "cluster_status" }
```

### `configure_cluster`

Resets and replaces the entire clustering configuration. Each entry follows the `add_node` schema.

```json
{
	"operation": "configure_cluster",
	"connections": [
		{
			"hostname": "server-two",
			"subscriptions": [{ "database": "dev", "table": "dog", "subscribe": true, "publish": true }]
		}
	]
}
```
