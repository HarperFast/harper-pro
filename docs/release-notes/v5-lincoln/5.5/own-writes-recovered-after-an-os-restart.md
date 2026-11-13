---
section: 'Replication'
---

### Own Writes Recovered After an OS Restart

After an OS crash, power loss or reboot, a node may have lost its most recent commits even though peers confirmed them. It now asks each peer for the writes it originated and applies the ones it is missing. Until every peer and every node in the record lock home map has answered, a [cluster record lock](/reference/v5/replication/overview#cluster-record-locks) on that node that depends on its writes from before the restart waits within its timeout and then answers `503`. A restart of Harper alone, with the OS still running, loses nothing and skips this.

- Every node a node sends a database to must also send it back; on a one-way route such locks stay at `503`.
- Writes to a sharded table (one with a residency policy) are not recovered this way, and locks on such a table do not wait for recovery.
