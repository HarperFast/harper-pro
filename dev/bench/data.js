window.BENCHMARK_DATA = {
  "lastUpdate": 1782644901902,
  "repoUrl": "https://github.com/HarperFast/harper-pro",
  "entries": {
    "YCSB Cluster Throughput": [
      {
        "commit": {
          "author": {
            "name": "harperfastaibot[bot]",
            "username": "harperfastaibot[bot]",
            "email": "280766738+harperfastaibot[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "9afa7ea758d05eb7b067e91af5b19f20bb40c3ab",
          "message": "feat: Sync Core (#365)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-06-13T11:50:55Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/9afa7ea758d05eb7b067e91af5b19f20bb40c3ab"
        },
        "date": 1781435621061,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10001.61,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 22506.98,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8384.77,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 9546.23,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4584.27,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2034.5,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "2cb2f0d23bb86e15b77cba10ecf481371d5950e0",
          "message": "test(replication): authoritative-table blob byte-integrity after receive-side save failure\n\nAdds a stress-gated integration regression guard under integrationTests/cluster/ for the\nauthoritative (non-caching) blob path: a receive-side blob save fails on the follower\nmid-stream, the follower restarts, and after the watermark-driven re-stream every record's\nfile-backed blob must be present, full-size, and byte-for-byte correct -- verified with the\nSOURCE node offline so a read cannot re-source and mask a missing blob.\n\n  - fixture-large-blob-authoritative: a plain @table @export AuthLocation (NO sourcedFrom)\n    with a SeedAuthLocation GET endpoint that writes deterministic 50 KB file-backed blobs,\n    and an AuthLocationImage resource serving the raw bytes for byte-exact verification. The\n    component is deployed to BOTH nodes (replicated to the leader for schema+data, and\n    explicitly to the follower so it serves the REST export used by the integrity check).\n  - reuses #368's fixture-blob-fail-transient injector to fail one receive-side blob save.\n\nStacks on #368 (the blob-gap durability watermark): this test passes on the watermark\nreceive path -- the follower converges with no wedge and the disrupted record's blob is\nre-saved by the natural same-version overwrite of the re-streamed record.\n\nNOTE: this commit drops the core-side repair from harper PR #1281. That PR added a dedicated\nrepair at the identity-tie duplicate-drop in core Table._writeUpdate, on the theory that the\nre-streamed authoritative record arrives as an identity-tie duplicate and is dropped, leaving\nthe row's blob reference dangling. Empirical testing on the watermark-based #368 path showed\notherwise: across repeated runs the disrupted record's blob is reliably re-saved by the\nnatural same-version overwrite (the audit-walk auditStore.get lookup that gated the repair\nbranch reliably misses, so the record never reaches the tie-drop), and the repair branch never\nfired. The core submodule pointer is therefore reverted to #368's base (no repair), and this\ntest is retained as the lasting value: it guards the data-integrity OUTCOME rather than the\nmechanism. See PR #1281 for the disposition.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-06-13T22:03:22Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/2cb2f0d23bb86e15b77cba10ecf481371d5950e0"
        },
        "date": 1781526616557,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 1817.69,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 5914.16,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 4964.76,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 3500.79,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 1903.74,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 789.13,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "cefb6ceffc74f839117eafa1ae372d9dd5b2f513",
          "message": "5.1.2",
          "timestamp": "2026-06-16T05:02:34Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/cefb6ceffc74f839117eafa1ae372d9dd5b2f513"
        },
        "date": 1781611887311,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 1740.76,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 21349.12,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 3756.52,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 3604.52,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 2400.38,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 970.34,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "harperfastaibot[bot]",
            "username": "harperfastaibot[bot]",
            "email": "280766738+harperfastaibot[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "fa16ed40a85d6d09f745ac31dfc847fc3bdfe593",
          "message": "feat: Sync Core (#407)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-06-17T11:49:59Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/fa16ed40a85d6d09f745ac31dfc847fc3bdfe593"
        },
        "date": 1781697070124,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 11040.41,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 22512.59,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 21524.37,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 4368.58,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4464.64,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1475.55,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "bdadb1ecf3587a1cf3f46b239abf449c092ddc9e",
          "message": "test(fixture): remove artificial async delays from blob generator in cluster test fixture (#408)\n\nThe sourcedFrom blob used 150 async yields with 0–9ms delays (total ~675ms). After\nharper#1341 (fix blob cleanup on skipped replication applies), the replication commit for\na received record now awaits the blob's save promise before committing — intentional, so\nthe record isn't stored before its blob is durable. This pushed the effective commit time\nfor Location/2 on node 1 past the test's 500ms wait, causing `bodyFrom1.random !==\nbodyFrom2.random` because node 1 re-invoked the source's get() independently.\n\nRemove the per-yield delays (they were ornamental). The generator now completes\nsynchronously, the blob saves in one I/O burst, and the 500ms replication window is ample.\n\nFixes the consistent shard 4/4 failure across all Node versions (v22/v24/v26) introduced\nby harper#1341 + hp#405 for the v5.1.4 release.\n\nCo-authored-by: Claude Sonnet 4.6 <noreply@anthropic.com>",
          "timestamp": "2026-06-17T15:12:30Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/bdadb1ecf3587a1cf3f46b239abf449c092ddc9e"
        },
        "date": 1781782942577,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 9836.19,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 23703.73,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 6036.49,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 8708.69,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 2816.88,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1398.94,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "24818b15a78e5b08f72bdd7ec5d3f999be68b140",
          "message": "bench-runner: support org-level runner registration (default SCOPE=org)\n\nThe ephemeral bench runner was hard-coded to a repo-scoped registration on\nHarperFast/harper-pro, so only harper-pro workflows could use the harper-bench\nhost. Register at org scope by default (org URL + org registration token) so a\nsingle host loop — and thus a single job at a time, preserving comparable perf\nnumbers — serves every HarperFast repo's bench workflow (e.g. harper's new\nperf-benchmarks-nightly). SCOPE=repo restores the previous single-repo behavior.\n\nRequires the gh token to carry the admin:org scope for org-token minting.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-06-18T23:59:31Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/24818b15a78e5b08f72bdd7ec5d3f999be68b140"
        },
        "date": 1781869645385,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10192.49,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 25347.88,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 21788.42,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 5692.56,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5588.09,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2118.18,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "28c831017a8dd58ad82a1e0daabfb71622928e63",
          "message": "Release v5.1.6",
          "timestamp": "2026-06-19T20:38:43Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/28c831017a8dd58ad82a1e0daabfb71622928e63"
        },
        "date": 1781954358791,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 9341.51,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 27250.49,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 12602.1,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 8246.48,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4604.81,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2005.73,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "harperfastaibot[bot]",
            "username": "harperfastaibot[bot]",
            "email": "280766738+harperfastaibot[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "b8e54ddc0645a34eda496b044ad6264a405e1c8a",
          "message": "feat: Sync Core (#441)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-06-20T11:44:39Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/b8e54ddc0645a34eda496b044ad6264a405e1c8a"
        },
        "date": 1782041522254,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 7326.85,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 20929.95,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 15696.45,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7365.94,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4961.97,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2529.77,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "harperfastaibot[bot]",
            "username": "harperfastaibot[bot]",
            "email": "280766738+harperfastaibot[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "85f176c70401f4d08b04f35f0e67b23697048426",
          "message": "feat: Sync Core (#447)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-06-21T11:54:27Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/85f176c70401f4d08b04f35f0e67b23697048426"
        },
        "date": 1782130983547,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 11617.49,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 26253.74,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 23915.21,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 10780.04,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 7417.58,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 3364.02,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "6bb5289f313591b428a4ec92e43c1be7581df551",
          "message": "test(cluster): promote QA-campaign cluster regression tests (#442)\n\n* test(cluster): promote QA-campaign cluster regression tests\n\nAdd three cluster regression tests verified passing on main:\n- replicationConflictDeterminism: LWW convergence, no split-brain, addTo CRDT merge\n- typedStructReplicationDivergence: randomAccessFields:true replication across pre-diverged/late-join/restart (#1163 guard)\n- blobOrphanFullCopyConverges: TTL-orphaned blobs don't wedge full-copy (#403/#405/#429 guard)\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>\n\n* test(cluster): rename QA fixtures to match test names\n\nfixture-qa014-conflict      -> fixture-replication-conflict-determinism\nfixture-qa178-struct-dict   -> fixture-typed-struct-replication-divergence\nfixture-qa177-blob-ttl-copy -> fixture-blob-orphan-full-copy-converges\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix(lint): prefix unused label param with underscore\n\n---------\n\nCo-authored-by: Claude Sonnet 4.6 <noreply@anthropic.com>",
          "timestamp": "2026-06-23T00:03:20Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/6bb5289f313591b428a4ec92e43c1be7581df551"
        },
        "date": 1782219289618,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 9898.5,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 29619.4,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 23280.75,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 11475.1,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 8831.65,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 3511.87,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "4cc414043c2bfec5727ea0ff3ce59800a1adc789",
          "message": "Release v5.1.11",
          "timestamp": "2026-06-24T02:09:53Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/4cc414043c2bfec5727ea0ff3ce59800a1adc789"
        },
        "date": 1782300280001,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10816.59,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 27266.79,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 22814.34,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 9892.38,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 8637.64,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2940.89,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "714c0743ba6d7d62c7b69da900e5ecbd12fcb771",
          "message": "Release v5.1.14",
          "timestamp": "2026-06-25T18:45:34Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/714c0743ba6d7d62c7b69da900e5ecbd12fcb771"
        },
        "date": 1782473109715,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10904.94,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 26948.42,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 21240.46,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 11796.67,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 7339.28,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2917.41,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "harperfastaibot[bot]",
            "username": "harperfastaibot[bot]",
            "email": "280766738+harperfastaibot[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "d2abdcd084443dcf8172dc94704ef5fec9637ee1",
          "message": "feat: Sync Core (#493)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-06-26T12:36:55Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/d2abdcd084443dcf8172dc94704ef5fec9637ee1"
        },
        "date": 1782558084557,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10316.02,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 27034.57,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 22742.91,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 9438.21,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 7811.36,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 3598.01,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "harperfastaibot[bot]",
            "username": "harperfastaibot[bot]",
            "email": "280766738+harperfastaibot[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "d2abdcd084443dcf8172dc94704ef5fec9637ee1",
          "message": "feat: Sync Core (#493)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-06-26T12:36:55Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/d2abdcd084443dcf8172dc94704ef5fec9637ee1"
        },
        "date": 1782644898756,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10319.9,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 26716.35,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 22935.29,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 10606.94,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 7480.74,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 3244,
            "unit": "ops/sec"
          }
        ]
      }
    ],
    "YCSB Cluster Latency p99": [
      {
        "commit": {
          "author": {
            "name": "harperfastaibot[bot]",
            "username": "harperfastaibot[bot]",
            "email": "280766738+harperfastaibot[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "9afa7ea758d05eb7b067e91af5b19f20bb40c3ab",
          "message": "feat: Sync Core (#365)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-06-13T11:50:55Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/9afa7ea758d05eb7b067e91af5b19f20bb40c3ab"
        },
        "date": 1781435624059,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 7.17,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 62.19,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 70.41,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 19.9,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 21.35,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 71.51,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 147.26,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 247.39,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 145.48,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "2cb2f0d23bb86e15b77cba10ecf481371d5950e0",
          "message": "test(replication): authoritative-table blob byte-integrity after receive-side save failure\n\nAdds a stress-gated integration regression guard under integrationTests/cluster/ for the\nauthoritative (non-caching) blob path: a receive-side blob save fails on the follower\nmid-stream, the follower restarts, and after the watermark-driven re-stream every record's\nfile-backed blob must be present, full-size, and byte-for-byte correct -- verified with the\nSOURCE node offline so a read cannot re-source and mask a missing blob.\n\n  - fixture-large-blob-authoritative: a plain @table @export AuthLocation (NO sourcedFrom)\n    with a SeedAuthLocation GET endpoint that writes deterministic 50 KB file-backed blobs,\n    and an AuthLocationImage resource serving the raw bytes for byte-exact verification. The\n    component is deployed to BOTH nodes (replicated to the leader for schema+data, and\n    explicitly to the follower so it serves the REST export used by the integrity check).\n  - reuses #368's fixture-blob-fail-transient injector to fail one receive-side blob save.\n\nStacks on #368 (the blob-gap durability watermark): this test passes on the watermark\nreceive path -- the follower converges with no wedge and the disrupted record's blob is\nre-saved by the natural same-version overwrite of the re-streamed record.\n\nNOTE: this commit drops the core-side repair from harper PR #1281. That PR added a dedicated\nrepair at the identity-tie duplicate-drop in core Table._writeUpdate, on the theory that the\nre-streamed authoritative record arrives as an identity-tie duplicate and is dropped, leaving\nthe row's blob reference dangling. Empirical testing on the watermark-based #368 path showed\notherwise: across repeated runs the disrupted record's blob is reliably re-saved by the\nnatural same-version overwrite (the audit-walk auditStore.get lookup that gated the repair\nbranch reliably misses, so the record never reaches the tie-drop), and the repair branch never\nfired. The core submodule pointer is therefore reverted to #368's base (no repair), and this\ntest is retained as the lasting value: it guards the data-integrity OUTCOME rather than the\nmechanism. See PR #1281 for the disposition.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-06-13T22:03:22Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/2cb2f0d23bb86e15b77cba10ecf481371d5950e0"
        },
        "date": 1781526620808,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 92.72,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 90.27,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 102.88,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 126.83,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 138.44,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 160.98,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 313.81,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 371.94,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 544.12,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "cefb6ceffc74f839117eafa1ae372d9dd5b2f513",
          "message": "5.1.2",
          "timestamp": "2026-06-16T05:02:34Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/cefb6ceffc74f839117eafa1ae372d9dd5b2f513"
        },
        "date": 1781611891279,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 7.15,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 102.84,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 113.17,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 126.56,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 139.67,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 126.5,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 242.9,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 310.13,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 476.36,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "harperfastaibot[bot]",
            "username": "harperfastaibot[bot]",
            "email": "280766738+harperfastaibot[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "fa16ed40a85d6d09f745ac31dfc847fc3bdfe593",
          "message": "feat: Sync Core (#407)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-06-17T11:49:59Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/fa16ed40a85d6d09f745ac31dfc847fc3bdfe593"
        },
        "date": 1781697073108,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 6.98,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 7.95,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 11.55,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 90.27,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 112.01,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 67.92,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 144.79,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 385.11,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 107.14,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "bdadb1ecf3587a1cf3f46b239abf449c092ddc9e",
          "message": "test(fixture): remove artificial async delays from blob generator in cluster test fixture (#408)\n\nThe sourcedFrom blob used 150 async yields with 0–9ms delays (total ~675ms). After\nharper#1341 (fix blob cleanup on skipped replication applies), the replication commit for\na received record now awaits the blob's save promise before committing — intentional, so\nthe record isn't stored before its blob is durable. This pushed the effective commit time\nfor Location/2 on node 1 past the test's 500ms wait, causing `bodyFrom1.random !==\nbodyFrom2.random` because node 1 re-invoked the source's get() independently.\n\nRemove the per-yield delays (they were ornamental). The generator now completes\nsynchronously, the blob saves in one I/O burst, and the 500ms replication window is ample.\n\nFixes the consistent shard 4/4 failure across all Node versions (v22/v24/v26) introduced\nby harper#1341 + hp#405 for the v5.1.4 release.\n\nCo-authored-by: Claude Sonnet 4.6 <noreply@anthropic.com>",
          "timestamp": "2026-06-17T15:12:30Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/bdadb1ecf3587a1cf3f46b239abf449c092ddc9e"
        },
        "date": 1781782946171,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 6.53,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 59.27,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 68.43,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 30.35,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 32.29,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 96.68,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 179.55,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 151.3,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 436.35,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "24818b15a78e5b08f72bdd7ec5d3f999be68b140",
          "message": "bench-runner: support org-level runner registration (default SCOPE=org)\n\nThe ephemeral bench runner was hard-coded to a repo-scoped registration on\nHarperFast/harper-pro, so only harper-pro workflows could use the harper-bench\nhost. Register at org scope by default (org URL + org registration token) so a\nsingle host loop — and thus a single job at a time, preserving comparable perf\nnumbers — serves every HarperFast repo's bench workflow (e.g. harper's new\nperf-benchmarks-nightly). SCOPE=repo restores the previous single-repo behavior.\n\nRequires the gh token to carry the admin:org scope for org-token minting.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-06-18T23:59:31Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/24818b15a78e5b08f72bdd7ec5d3f999be68b140"
        },
        "date": 1781869648916,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 6.31,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 7.06,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 9.02,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 72.38,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 80.92,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 59.66,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 122.65,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 258.25,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 103.7,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "28c831017a8dd58ad82a1e0daabfb71622928e63",
          "message": "Release v5.1.6",
          "timestamp": "2026-06-19T20:38:43Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/28c831017a8dd58ad82a1e0daabfb71622928e63"
        },
        "date": 1781954361701,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.01,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 28.93,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 33.32,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 49.21,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 51.45,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 64.57,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 134.68,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 262.09,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 97.4,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "harperfastaibot[bot]",
            "username": "harperfastaibot[bot]",
            "email": "280766738+harperfastaibot[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "b8e54ddc0645a34eda496b044ad6264a405e1c8a",
          "message": "feat: Sync Core (#441)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-06-20T11:44:39Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/b8e54ddc0645a34eda496b044ad6264a405e1c8a"
        },
        "date": 1782041526582,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 7.67,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 13.32,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 16.08,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 21.39,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 22.57,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 20.83,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 40.44,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 56.44,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 142.69,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "harperfastaibot[bot]",
            "username": "harperfastaibot[bot]",
            "email": "280766738+harperfastaibot[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "85f176c70401f4d08b04f35f0e67b23697048426",
          "message": "feat: Sync Core (#447)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-06-21T11:54:27Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/85f176c70401f4d08b04f35f0e67b23697048426"
        },
        "date": 1782130987387,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.27,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 6.29,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 9.01,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 16.93,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 17.99,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 18.17,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 35.36,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 113.8,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 42.93,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "6bb5289f313591b428a4ec92e43c1be7581df551",
          "message": "test(cluster): promote QA-campaign cluster regression tests (#442)\n\n* test(cluster): promote QA-campaign cluster regression tests\n\nAdd three cluster regression tests verified passing on main:\n- replicationConflictDeterminism: LWW convergence, no split-brain, addTo CRDT merge\n- typedStructReplicationDivergence: randomAccessFields:true replication across pre-diverged/late-join/restart (#1163 guard)\n- blobOrphanFullCopyConverges: TTL-orphaned blobs don't wedge full-copy (#403/#405/#429 guard)\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>\n\n* test(cluster): rename QA fixtures to match test names\n\nfixture-qa014-conflict      -> fixture-replication-conflict-determinism\nfixture-qa178-struct-dict   -> fixture-typed-struct-replication-divergence\nfixture-qa177-blob-ttl-copy -> fixture-blob-orphan-full-copy-converges\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix(lint): prefix unused label param with underscore\n\n---------\n\nCo-authored-by: Claude Sonnet 4.6 <noreply@anthropic.com>",
          "timestamp": "2026-06-23T00:03:20Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/6bb5289f313591b428a4ec92e43c1be7581df551"
        },
        "date": 1782219292912,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 4.65,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 7.08,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 7.97,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.21,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 18.08,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 16.16,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 30.84,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 96.02,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 42.32,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "4cc414043c2bfec5727ea0ff3ce59800a1adc789",
          "message": "Release v5.1.11",
          "timestamp": "2026-06-24T02:09:53Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/4cc414043c2bfec5727ea0ff3ce59800a1adc789"
        },
        "date": 1782300283164,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 4.89,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 6.8,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 8.04,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.1,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 19.34,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.6,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 30.56,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 108.23,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 42.14,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "714c0743ba6d7d62c7b69da900e5ecbd12fcb771",
          "message": "Release v5.1.14",
          "timestamp": "2026-06-25T18:45:34Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/714c0743ba6d7d62c7b69da900e5ecbd12fcb771"
        },
        "date": 1782473112815,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.24,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 8.25,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 11.29,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.31,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 19.73,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 16.78,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 32.67,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 137.4,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 39.63,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "harperfastaibot[bot]",
            "username": "harperfastaibot[bot]",
            "email": "280766738+harperfastaibot[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "d2abdcd084443dcf8172dc94704ef5fec9637ee1",
          "message": "feat: Sync Core (#493)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-06-26T12:36:55Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/d2abdcd084443dcf8172dc94704ef5fec9637ee1"
        },
        "date": 1782558087667,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 4.9,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 6.99,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 8.06,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.46,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 18.22,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 16.35,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 31.85,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 107.15,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 34.14,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "harperfastaibot[bot]",
            "username": "harperfastaibot[bot]",
            "email": "280766738+harperfastaibot[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "d2abdcd084443dcf8172dc94704ef5fec9637ee1",
          "message": "feat: Sync Core (#493)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-06-26T12:36:55Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/d2abdcd084443dcf8172dc94704ef5fec9637ee1"
        },
        "date": 1782644901881,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 4.98,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 6.57,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 7.36,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.3,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 18.47,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 16.11,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 31.36,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 96.6,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 39.81,
            "unit": "ms"
          }
        ]
      }
    ]
  }
}