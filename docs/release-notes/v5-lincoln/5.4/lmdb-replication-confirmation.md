---
section: 'Replication'
order: 30
---

### LMDB Replication Confirmation

LMDB writes that request `replicatedConfirmation` now wait for peer acknowledgments. Applications that previously received immediate success can now observe replication latency or an uncertain committed outcome if confirmation fails. See [Confirmation Failure After a Local Commit](/reference/v5/replication/sharding#confirmation-failure-after-a-local-commit) before retrying a failed write.
