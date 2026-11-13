---
section: 'Replication'
---

### Cloned Applications Keep Their node_modules

A clone used to rebuild each filesystem-only application's `node_modules` with `npm install`, so a package whose only copy was in `node_modules` (a `file:./node_modules/...` dependency, or a private workspace package in a Next.js standalone build) was lost, and the clone still reported `Available` and served `500` errors. A clone now copies each such application with its `node_modules` from a leader running 5.2.3 or later. A clone from an older leader, or one authenticated by certificate, rebuilds with npm as before and logs that `node_modules`-only packages will be missing. An application that still fails after three attempts stops clone setup, and the node stays `Unavailable`. A request to the leader that receives no data for 10 minutes now fails instead of waiting forever. This is also in 5.3.3. See [harper-pro#1050](https://github.com/HarperFast/harper-pro/pull/1050).

A clone that cannot save its attempt marker (`.cloneAttempt.json`) now stops with an error naming the path before it contacts the leader. Before, it cloned without the safeguards replication applies to a clone. See [harper-pro#1250](https://github.com/HarperFast/harper-pro/pull/1250).
