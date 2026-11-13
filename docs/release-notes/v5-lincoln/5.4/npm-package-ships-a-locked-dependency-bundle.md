---
section: 'Container Images'
order: 20
---

### The npm Package Ships Its Tested Dependencies

`@harperfast/harper-pro` on npm now bundles the JavaScript dependency tree it was tested with, instead of publishing an `npm-shrinkwrap.json`, which npm 12 ignores and a tarball install never reads. `npm install -g @harperfast/harper-pro` then installs the same bundled JavaScript tree on npm 10, 11 and 12; the native packages `re2` and `@datadog/pprof` are installed separately, and `re2` and both packages' own dependencies still resolve from version ranges. The package is larger (about 41 MB gzipped, up from 18.5 MB). npm 12 skips dependency install scripts by default, and without them the WAF component does not load; install with `npm install -g --allow-scripts=re2 @harperfast/harper-pro`, as the [README](https://github.com/HarperFast/harper-pro#installing-harper-pro) shows. This is also in 5.3.2. See [harper-pro#981](https://github.com/HarperFast/harper-pro/pull/981).
