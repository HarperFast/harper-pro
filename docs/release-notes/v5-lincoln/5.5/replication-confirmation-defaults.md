---
section: 'Replication'
---

### Default Replication Confirmation

Two settings, both off by default, make writes wait for peer confirmation without changing each write path:

- [`replication.confirmation`](/reference/v5/replication/sharding#default-confirmation-count) is the peer count a write waits for when it requests none. A write's own count, including `0`, still takes precedence.
- [`replication.recordLockConfirmation`](/reference/v5/replication/overview#confirming-locked-writes) makes a commit that holds a cluster record lock wait for at least that many peers. Without it, a holder that loses power before its write replicates can lose the write, and the next holder can be admitted without it.

A node that replicates a database to fewer peers than `replication.confirmation` refuses writes to it, so set the key once the cluster has formed. A write to a table declared `replicate: false` no longer waits for confirmation, which no peer could give.
