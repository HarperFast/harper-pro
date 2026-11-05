# Harper Pro documentation source

Reference pages for Harper Pro features, partials for the Harper Pro sections of core reference pages, and Harper Pro release-note fragments. The layout, the fragment format and how to preview are described in [harper's docs/README.md](https://github.com/HarperFast/harper/blob/main/docs/README.md), which this directory follows; [AGENTS.md](https://github.com/HarperFast/harper/blob/main/docs/AGENTS.md) there holds the writing rules.

Pages here are published at the same paths as harper's (`docs/reference/replication/overview.md` → `/reference/v5/replication/overview`), and a path provided by both repos fails the site build. Preview from a [HarperFast/documentation](https://github.com/HarperFast/documentation) checkout next to this one, after `npm ci` there:

```bash
HARPER_PRO_DOCS_PATH=../harper-pro npm run dev
```

The core docs then come from `core/` (or from the commit `core` points to, when the submodule is not checked out).

The PR build uses the core docs at this repo's `core` submodule commit, so a core page that imports a new partial from here needs the partial merged here first, and a partial that links to a new core page needs the `core` bump that brings it.

A PR that changes `docs/` or `core` also gets a deployed preview: a comment on the PR links to the site built from its head, with the core docs at its `core` commit, so a harper PR and the harper-pro PR that bumps `core` to it preview together. The comment updates on each push and says when the preview is removed at close. A fork's PR waits for a maintainer to approve the build. HarperFast/documentation builds and hosts it ([how](https://github.com/HarperFast/documentation/blob/main/CONTRIBUTING.md#reference-and-release-notes-content)).
