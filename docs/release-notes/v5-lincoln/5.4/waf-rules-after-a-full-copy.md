---
section: 'Security'
order: 20
---

### WAF Rules After a Full Copy

A node that joined or rejoined a cluster through a full copy could store the copied [WAF](/reference/v5/web-application-firewall/overview) rules without enforcing them. Nothing reported the gap, and it lasted until the next rule write or a restart. Each worker now recompiles its matcher when the copy completes, and again whenever its rule subscription recovers. A scan or compile that fails now retries with backoff instead of waiting for the next rule write. See [harper-pro#889](https://github.com/HarperFast/harper-pro/issues/889).
