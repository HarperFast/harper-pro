---
section: 'Replication'
---

### remove_node Accepts the Address a Node Was Added With

`remove_node` now finds a peer by the hostname or URL it was added with, as `update_node` already did. A peer added by IP address or alias, and stored under the name it reports, could not be removed by that address: the call answered `400` with `does not exist`. An address that matches more than one node is refused with the candidates listed. When the removed node does not confirm its side of the removal within 30 seconds, the response still reports success, with `but removal on the target node was not confirmed` and the reason. See [Remove Node](/reference/v5/replication/clustering#remove-node) and [harper-pro#986](https://github.com/HarperFast/harper-pro/pull/986).
