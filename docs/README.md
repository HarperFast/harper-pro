# Harper Pro documentation source

Reference pages for Harper Pro features, partials for the Harper Pro sections of core reference pages, and Harper Pro release-note fragments. The layout, the fragment format and how to preview are described in [harper's docs/README.md](https://github.com/HarperFast/harper/blob/main/docs/README.md), which this directory follows; [AGENTS.md](https://github.com/HarperFast/harper/blob/main/docs/AGENTS.md) there holds the writing rules.

Pages here are published at the same paths as harper's (`docs/reference/replication/overview.md` → `/reference/v5/replication/overview`), and a path provided by both repos fails the site build. Preview from a [HarperFast/documentation](https://github.com/HarperFast/documentation) checkout next to this one, after `npm ci` there:

```bash
HARPER_DOCS_PATH=../harper-pro/core HARPER_PRO_DOCS_PATH=../harper-pro npm run dev
```

The PR build uses the core docs at this repo's `core` submodule commit, so a core page that imports a new partial from here needs the partial merged here first, and a partial that links to a new core page needs the `core` bump that brings it.
