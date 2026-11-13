---
section: 'Replication'
order: 14
---

### Replication Over Private Network Addresses

Nodes that share a private network (a VLAN or VPC) can now replicate over it instead of their public addresses, which some providers bill even within a region. A node lists its private addresses in `replication.privateUrls`, each a `wss://` URL with a `network` tag, and a peer whose own `privateUrls` or `replication.network` names the same tag dials that address instead of the node's `url`. The connection keeps the public URL's TLS server name and certificate, so certificates and SNI proxies need no change. If the private address does not connect, the link uses `url` and checks the private address again later. `cluster_status` reports each connection's `path`: `public`, `private` or `public-fallback`. Older nodes ignore the new settings and keep dialing `url`. See [Private Network Addresses](/reference/v5/replication/overview#private-network-addresses) and [harper-pro#1294](https://github.com/HarperFast/harper-pro/pull/1294).
