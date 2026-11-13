---
section: 'Container Images'
order: 5
---

### Harper Pro Images Run Node 26

The default `harperfast/harper-pro` tags, which Fabric clusters also use, now run Node 26, the current Active LTS line, instead of Node 24. The `-node22`, `-node24` and `-node26` tags are still published, so a deployment that needs to stay on Node 24 can pin `-node24`. The `-pc` (pointer-compression) image follows the same default. The OpenShift image (`harperfast/harper-pro-openshift`) stays on Node 24, since its UBI base has no Node 26 stream yet. See [harper-pro#1119](https://github.com/HarperFast/harper-pro/pull/1119).
