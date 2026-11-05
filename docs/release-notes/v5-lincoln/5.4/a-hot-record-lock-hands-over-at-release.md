---
section: 'Replication'
---

### A Hot Record Lock Hands Over at Release

[Keep a hot cluster record lock from stalling waiters to their deadline](https://github.com/HarperFast/harper/pull/4065) fixes a stall on a record many nodes lock at once. A node that had been granted the lock gave it up if another node asked for it before the node finished checking it had the latest data. With enough network delay every grant went that way, so waiters on every node failed with 423 or 503 at the end of their lock wait, though the holder had released. No lock was ever held by two nodes.

A node now finishes that check and serves the waiter it asked for before handing the lock on. It gives up a check that has not finished 6 seconds after being asked, so a node that cannot complete one does not hold up the others. The fix is complete once every node is upgraded.
