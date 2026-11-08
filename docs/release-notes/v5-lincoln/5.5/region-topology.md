---
section: 'Replication'
order: 40
---

### Region Topology

`replication.region` labels a node with its region. When every node has one, nodes link only within their region, and two gateways per region (or the nodes that set `replication.gateway: true`) carry traffic between regions, so a write crosses into each other region once instead of once per remote node. Losing a gateway moves its region to the other one. Clusters with a node that has no region keep the full mesh. Failover where region does not decide now prefers the lowest-latency peer. See [Region Topology](/reference/v5/replication/overview#region-topology).
