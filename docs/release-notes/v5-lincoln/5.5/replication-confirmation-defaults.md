---
section: 'Replication'
---

### Replication Confirmation Defaults

Two settings make writes wait for peer confirmation without changing each write path:

- [`replication.recordLockConfirmation`](/reference/v5/replication/overview#confirming-locked-writes) makes a commit that holds a cluster record lock wait for at least that many peers. It is `1` by default while `replication.recordLocks` is `true`. Without it, a holder that loses power before its write replicates can lose the write, and the next holder can be admitted without it.
  - While no peer is connected, a locked commit is refused with `503` before anything is written, rather than waiting. A wait whose peers drop ends within about twice `pingTimeout` (about 2 minutes by default), and its `504` says the write committed on this node but was not confirmed.
  - Each locked commit now waits one replication round trip. Set `recordLockConfirmation: 0` to keep the previous behaviour; a single-node cluster with record locks on must, or its locked commits are refused.
  - Nodes with record locks off are unchanged.
- [`replication.confirmation`](/reference/v5/replication/sharding#default-confirmation-count), off by default, is the peer count a write waits for when it requests none. A write's own count, including `0`, still takes precedence. A node that replicates a database to fewer peers than this count refuses writes to it, so set the key once the cluster has formed.

A write to a table declared `replicate: false` no longer waits for confirmation, which no peer could give.
