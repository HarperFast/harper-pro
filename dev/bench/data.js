window.BENCHMARK_DATA = {
  "lastUpdate": 1784112962344,
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
        "date": 1782734569475,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10311.18,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 27234.39,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 22909.92,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 8981.66,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 8556.84,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 3521.08,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "renovate[bot]",
            "username": "renovate[bot]",
            "email": "29139614+renovate[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "5572723f24f7f407051b89f157a60e60853cc627",
          "message": "chore(deps): update actions/checkout action to v7 (#501)\n\nCo-authored-by: renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>",
          "timestamp": "2026-06-29T15:12:27Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/5572723f24f7f407051b89f157a60e60853cc627"
        },
        "date": 1782776795381,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10681.3,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 27531,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 22708.51,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 8896.54,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 7856.3,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 3006.59,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Nathan Heskew",
            "username": "heskew",
            "email": "nathan@harperdb.io"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "11fda005b62c5e319a61ba55888a978abb023791",
          "message": "Merge pull request #503 from HarperFast/chore/bump-ai-review-prompts-67d7611\n\nchore(ci): bump ai-review-prompts to 9cf49d2 (calibration #70 + prompt-ref tracking #71)",
          "timestamp": "2026-06-30T04:46:05Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/11fda005b62c5e319a61ba55888a978abb023791"
        },
        "date": 1782818756190,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 11269.8,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 27243.77,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 21443.49,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 10369.12,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 8105.75,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 3023.2,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Nathan Heskew",
            "username": "heskew",
            "email": "nathan@harperdb.io"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "11fda005b62c5e319a61ba55888a978abb023791",
          "message": "Merge pull request #503 from HarperFast/chore/bump-ai-review-prompts-67d7611\n\nchore(ci): bump ai-review-prompts to 9cf49d2 (calibration #70 + prompt-ref tracking #71)",
          "timestamp": "2026-06-30T04:46:05Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/11fda005b62c5e319a61ba55888a978abb023791"
        },
        "date": 1782905299088,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 9623.38,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 29047.14,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 23551.62,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 10979.54,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 7282,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 3915.93,
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
          "id": "b9f083c2b94a8570a181ea59afd087b5b0401358",
          "message": "Release v5.1.15",
          "timestamp": "2026-07-01T14:20:09Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/b9f083c2b94a8570a181ea59afd087b5b0401358"
        },
        "date": 1782991131166,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10646.38,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 27018.43,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 22932.7,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 9372.1,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 6535.15,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2627.48,
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
          "id": "f379f162996d6f7562c945dd26be9b639d4a142d",
          "message": "Make replication connection state authoritative via shared memory (W1, #431) (#445)\n\n* Make replication connection state authoritative via shared memory (W1, #431)\n\nThe main thread infers each outbound (db,peer) subscription's connected\nstate from edge-triggered worker->main messages, which desync when a\nterminal/idle state is reached without a 'close' (open-but-idle wedge,\ninto the existing per-(db,peer) shared-memory Float64Array (slots 9-12:\nstate/liveness/error-code/error-time). The main thread reads it as truth:\ncluster_status reports the accurate connected plus a new lastConnectionError\n(#214), and reconcileWorkers corrects the inferred flag against it, feeding\nthe existing wedge recovery.\n\nconnected = CONNECTED state AND fresh liveness, so a worker that died or\nwedged without writing DOWN still reads down once liveness goes stale.\nLiveness is written at the NODE_NAME handshake, on pong, and on received\ndata; a backpressure pause refreshes it (matching shouldTerminateIdlePing's\npauseReasons exemption). LIVENESS_STALE_MS derives from PING_TIMEOUT.\n\nFirst of two PRs for W1 (#431); this is the state-truth data plane.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* Write wall-clock Date.now() to liveness slot in the backpressure-pause refresh\n\nLAST_LIVENESS_TIME_POSITION holds a wall-clock timestamp that the main thread\ncompares against Date.now() in deriveConnectionTruth. The backpressure-pause\nrefresh in sendPing was writing lastByteActivity (performance.now(), a monotonic\nclock relative to process start), so the slot would read as far in the past and\na healthy-but-paused link would be marked stale/down — the opposite of the\nrefresh's intent. Write Date.now() instead, matching every other liveness write.\n\nAddresses the gemini-code-assist critical review finding on #445.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-07-02T15:52:45Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/f379f162996d6f7562c945dd26be9b639d4a142d"
        },
        "date": 1783077275677,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 11127.73,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 27174.08,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 23002.22,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 9663.75,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 8014.4,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 3668.41,
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
          "id": "f379f162996d6f7562c945dd26be9b639d4a142d",
          "message": "Make replication connection state authoritative via shared memory (W1, #431) (#445)\n\n* Make replication connection state authoritative via shared memory (W1, #431)\n\nThe main thread infers each outbound (db,peer) subscription's connected\nstate from edge-triggered worker->main messages, which desync when a\nterminal/idle state is reached without a 'close' (open-but-idle wedge,\ninto the existing per-(db,peer) shared-memory Float64Array (slots 9-12:\nstate/liveness/error-code/error-time). The main thread reads it as truth:\ncluster_status reports the accurate connected plus a new lastConnectionError\n(#214), and reconcileWorkers corrects the inferred flag against it, feeding\nthe existing wedge recovery.\n\nconnected = CONNECTED state AND fresh liveness, so a worker that died or\nwedged without writing DOWN still reads down once liveness goes stale.\nLiveness is written at the NODE_NAME handshake, on pong, and on received\ndata; a backpressure pause refreshes it (matching shouldTerminateIdlePing's\npauseReasons exemption). LIVENESS_STALE_MS derives from PING_TIMEOUT.\n\nFirst of two PRs for W1 (#431); this is the state-truth data plane.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* Write wall-clock Date.now() to liveness slot in the backpressure-pause refresh\n\nLAST_LIVENESS_TIME_POSITION holds a wall-clock timestamp that the main thread\ncompares against Date.now() in deriveConnectionTruth. The backpressure-pause\nrefresh in sendPing was writing lastByteActivity (performance.now(), a monotonic\nclock relative to process start), so the slot would read as far in the past and\na healthy-but-paused link would be marked stale/down — the opposite of the\nrefresh's intent. Write Date.now() instead, matching every other liveness write.\n\nAddresses the gemini-code-assist critical review finding on #445.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-07-02T15:52:45Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/f379f162996d6f7562c945dd26be9b639d4a142d"
        },
        "date": 1783162675208,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 9866.81,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 27924.36,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 23843.56,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 10760.38,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 8226.79,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 3542.02,
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
          "id": "bcd9c8f54156141e9136bb52f81c1efeaa245dd0",
          "message": "feat: Sync Core (#519)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-07-04T18:36:06Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/bcd9c8f54156141e9136bb52f81c1efeaa245dd0"
        },
        "date": 1783249343803,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 9986.2,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 27814.79,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 24416.46,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 11404.36,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 9695.43,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 3761.65,
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
          "id": "bcd9c8f54156141e9136bb52f81c1efeaa245dd0",
          "message": "feat: Sync Core (#519)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-07-04T18:36:06Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/bcd9c8f54156141e9136bb52f81c1efeaa245dd0"
        },
        "date": 1783338710368,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10459.2,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 27586.17,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 23695.24,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 11574.2,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 9016.19,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 3614.64,
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
          "id": "795d5cd24012feba06300ff535a1f0b63a9b0307",
          "message": "feat(replication): expose connection-truth liveness age in cluster_status (#431)\n\ncluster_status already reports the shared-memory connection truth (connected\noverride + lastConnectionError, from #445). Add the missing piece: lastLiveness,\nthe wall-clock of the link's last proof-of-life (handshake/pong/receive stamp).\nOperators — and the W1 watchdog-demotion soak — need to see how fresh the truth\nbehind `connected` is, distinguishing an actively-alive link from one nearing\nthe staleness window.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-07-06T04:17:25Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/795d5cd24012feba06300ff535a1f0b63a9b0307"
        },
        "date": 1783423238414,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 9991.75,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 28862.66,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 24619.17,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 12901.47,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 10085.42,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 3740.34,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Lavinia",
            "username": "ldt1996",
            "email": "lavinia@harperdb.io"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "9af593e81ed571b369635fcdc71bd5e273d8a84b",
          "message": "fix(replication): bound the blob send path under backpressure (#534)\n\n* fix(replication): bound blob-send concurrency and sweep orphan blob streams every 60s\n\n* fix(replication): resolve writer drain wait on close, guard callback pushes with wsClosed, floor the sweep interval (review)",
          "timestamp": "2026-07-07T18:06:48Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/9af593e81ed571b369635fcdc71bd5e273d8a84b"
        },
        "date": 1783508445368,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10694.13,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 27917.47,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 24284.43,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 12699.15,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 9524.61,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 3718.64,
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
          "id": "e40e8ba4c90bd9395ea4cd33d30866942c7b8883",
          "message": "fix(replication): harden closeOnInboundMessageError logging (PR #511 review)\n\nGemini findings: guard the logger access fully (the log must never\nprevent the close) and make the decode-error log readable when the\ntable decoder is unknown.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-01T22:58:49Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/e40e8ba4c90bd9395ea4cd33d30866942c7b8883"
        },
        "date": 1783682526252,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 9816.99,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 27596.26,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 24099.37,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 10297.09,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 8666.33,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 3593.28,
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
          "id": "c5850bde98a0fbb66ae55a8734761e7f5b49cd1f",
          "message": "test: guard every HARPER_BUILTIN_COMPONENTS entry has a defaultConfig.yaml key\n\nPer PR #560 review: nothing previously enforced that a built-in\ncomponent registered in bin/harper.js actually has a matching key in\nstatic/defaultConfig.yaml, so componentLoader.ts's\n`if (!config[componentName]) continue;` can silently skip loading any\nfuture built-in the same way it did secretCustody. Verified this test\nfails with the pre-fix defaultConfig.yaml (missing secretCustody key)\nand passes with it restored.",
          "timestamp": "2026-07-10T20:42:20Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/c5850bde98a0fbb66ae55a8734761e7f5b49cd1f"
        },
        "date": 1783766753131,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10923.9,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 28269.19,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 23815.58,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 11814.33,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 8682.34,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 3879.32,
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
          "id": "7f4e30a40cfda9e0c4adc24b09a8113897b59a08",
          "message": "chore: bump version to 5.2.0-alpha.3\n\nBump core submodule to latest main (31de6a3b).",
          "timestamp": "2026-07-11T22:57:01Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/7f4e30a40cfda9e0c4adc24b09a8113897b59a08"
        },
        "date": 1783853363602,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 9434.5,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 27756.35,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 23857.75,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 10603.29,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 8527.26,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 3894.18,
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
          "id": "7f4e30a40cfda9e0c4adc24b09a8113897b59a08",
          "message": "chore: bump version to 5.2.0-alpha.3\n\nBump core submodule to latest main (31de6a3b).",
          "timestamp": "2026-07-11T22:57:01Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/7f4e30a40cfda9e0c4adc24b09a8113897b59a08"
        },
        "date": 1783941826655,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10939.58,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 27308.53,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 22748.93,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 10919.22,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 8953.1,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 3259.92,
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
          "id": "3215f3357c9325eaf3062096eb39853452f4027d",
          "message": "fix: tighten engines.node to match re2's install-time requirement\n\nre2 (and its node-gyp source-build fallback) requires\n^22.22.2 || ^24.15.0 || >=26.0.0, narrower than the root package.json's\n^22.18.0 || >=24.0.0. Node 22.18.0-22.22.1 and 24.0.0-24.14.x satisfy\nthe old range but not re2's, so an install on one of those patch\nversions would warn/fail. Tighten the declared range to match.",
          "timestamp": "2026-07-14T01:24:10Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/3215f3357c9325eaf3062096eb39853452f4027d"
        },
        "date": 1784026731483,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 9499.55,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 25030.03,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 19539.35,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7709.29,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5852.38,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2471.22,
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
          "id": "0b49587f56d4bf6fb55703c0818b47ee2af610cf",
          "message": "Constrain replication mesh when the system database is replicated (#572)\n\n* spike: directional hdb_nodes self-record to constrain mesh under system replication\n\nDerive a directional replicates object (sendsTo/receivesFrom, per-database) for a\nnode's own hdb_nodes record from its config routes instead of a blanket replicates:true.\nLets the system db replicate for discovery/config propagation while user-db connections\nstay on the configured topology, enforced by the existing #498 gates.\n\nIncludes two integration repros (3-tier chain; per-database opposite directions).\nValidated by hot-patching dist; see repro output in session.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* Constrain replication mesh when the system database is replicated\n\nDerive a directional hdb_nodes self-record from a node's config routes\n(computeSelfReplicates) instead of a blanket replicates:true, so `system`\ncan replicate for discovery/config propagation without every aggregation\nnode opening direct connections to every discovered peer. The existing\n#498 gates consult the propagated directional record; opt-in, so nodes\nwith no directional routes keep legacy full-mesh.\n\n- computeSelfReplicates + getConfiguredRoutes extracted/module-scoped; opt-in\n  (only when >=1 directional route), explicit-none yields empty (not true).\n- ensureThisNode compares replicates structurally so config/deploy reloads refresh it.\n- setNode/addNodeBack derive the self-record the same way and drop the blanket\n  sends:true on directional peer records (was short-circuiting the allow-list).\n- mergeReconstructedNode preserves a peer's last-known directional replicates\n  through a transient decode miss (no topology widening).\n- Unit tests (computeSelfReplicates/mergeReconstructedNode); integration tests\n  for transitive 3-tier, per-db opposite directions, and excluded-peer churn.\n- DESIGN.md documents the mechanism and its boundaries.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix: guard non-array sendsTo/receivesFrom, fix lint\n\n- computeSelfReplicates: Array.isArray guard on rep.sendsTo/receivesFrom\n  instead of `|| []` — route config comes from YAML and isn't schema-\n  validated, so a misconfigured non-array value would throw in the\n  for...of and crash boot. Matches the existing guard in\n  routeEntriesIncludePeer. Per gemini-code-assist review on PR #572.\n- systemDbPerDbDirectionRepro.test.mjs: remove unused nodeM destructure\n  (lint failure).\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix: address PR #572 review (Chris Barber)\n\nTwo directional-routing regressions found in review:\n\n- knownNodes.ts scanNodesForSubscription: the reconstruct-merge guard was\n  `!node.url || node.shard === undefined`, but on an UNSHARDED cluster every\n  real decoded record has shard === undefined, so mergeReconstructedNode ran\n  over real records and reverted a freshly-decoded `replicates` to a stale\n  in-memory value during a copyApply base-copy reload (harper-pro#489) —\n  dropping user-db records for a peer that widened, over-connecting to one\n  that narrowed. Gate strictly on `!node.url`: a real record always has a\n  url, so only true reconstruct descriptors are merged.\n\n- replicationConnection.ts dynamic send-authority gate: used a strict\n  `sub.source === thisNode && sub.database === databaseName`. A\n  full-replication neighbor's directional self-record advertises\n  `receivesFrom: [{ source }]` with NO database (wildcard), so once a node\n  was opted-in, its full-replication neighbors' per-database subscriptions\n  were rejected (close 1008) whenever the sender fell to the dynamic gate.\n  Delegate to routeEntriesIncludePeer (absent source/database = wildcard),\n  matching the receive-side gate.\n\n- Adds an integration test driving an opted-in full-replication neighbor\n  through the dynamic send path.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: KrAIs <kris@harperdb.io>\nCo-authored-by: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-07-15T02:01:17Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/0b49587f56d4bf6fb55703c0818b47ee2af610cf"
        },
        "date": 1784112958322,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10439.8,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 25506.44,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 21708.5,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 8920.6,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 6508.33,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 3236.35,
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
        "date": 1782734573692,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.38,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 7.03,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 10.24,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 29.66,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 31.53,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.55,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 29.51,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 104.85,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 43.24,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "renovate[bot]",
            "username": "renovate[bot]",
            "email": "29139614+renovate[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "5572723f24f7f407051b89f157a60e60853cc627",
          "message": "chore(deps): update actions/checkout action to v7 (#501)\n\nCo-authored-by: renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>",
          "timestamp": "2026-06-29T15:12:27Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/5572723f24f7f407051b89f157a60e60853cc627"
        },
        "date": 1782776798552,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 4.98,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 7.4,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 8.38,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 34.89,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 42.18,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.89,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 31.32,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 140.69,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 45.85,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Nathan Heskew",
            "username": "heskew",
            "email": "nathan@harperdb.io"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "11fda005b62c5e319a61ba55888a978abb023791",
          "message": "Merge pull request #503 from HarperFast/chore/bump-ai-review-prompts-67d7611\n\nchore(ci): bump ai-review-prompts to 9cf49d2 (calibration #70 + prompt-ref tracking #71)",
          "timestamp": "2026-06-30T04:46:05Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/11fda005b62c5e319a61ba55888a978abb023791"
        },
        "date": 1782818759335,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.53,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 7.99,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 11.01,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.54,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 18.38,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.91,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 30.98,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 37.94,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 124.72,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Nathan Heskew",
            "username": "heskew",
            "email": "nathan@harperdb.io"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "11fda005b62c5e319a61ba55888a978abb023791",
          "message": "Merge pull request #503 from HarperFast/chore/bump-ai-review-prompts-67d7611\n\nchore(ci): bump ai-review-prompts to 9cf49d2 (calibration #70 + prompt-ref tracking #71)",
          "timestamp": "2026-06-30T04:46:05Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/11fda005b62c5e319a61ba55888a978abb023791"
        },
        "date": 1782905302684,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 4.51,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 7.03,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 9.88,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.13,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 18.24,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 16.86,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 33.13,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 88.88,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 33.11,
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
          "id": "b9f083c2b94a8570a181ea59afd087b5b0401358",
          "message": "Release v5.1.15",
          "timestamp": "2026-07-01T14:20:09Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/b9f083c2b94a8570a181ea59afd087b5b0401358"
        },
        "date": 1782991135578,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 4.95,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 6.85,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 7.7,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.64,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 18.5,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 32.7,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 65.89,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 52.69,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 170.04,
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
          "id": "f379f162996d6f7562c945dd26be9b639d4a142d",
          "message": "Make replication connection state authoritative via shared memory (W1, #431) (#445)\n\n* Make replication connection state authoritative via shared memory (W1, #431)\n\nThe main thread infers each outbound (db,peer) subscription's connected\nstate from edge-triggered worker->main messages, which desync when a\nterminal/idle state is reached without a 'close' (open-but-idle wedge,\ninto the existing per-(db,peer) shared-memory Float64Array (slots 9-12:\nstate/liveness/error-code/error-time). The main thread reads it as truth:\ncluster_status reports the accurate connected plus a new lastConnectionError\n(#214), and reconcileWorkers corrects the inferred flag against it, feeding\nthe existing wedge recovery.\n\nconnected = CONNECTED state AND fresh liveness, so a worker that died or\nwedged without writing DOWN still reads down once liveness goes stale.\nLiveness is written at the NODE_NAME handshake, on pong, and on received\ndata; a backpressure pause refreshes it (matching shouldTerminateIdlePing's\npauseReasons exemption). LIVENESS_STALE_MS derives from PING_TIMEOUT.\n\nFirst of two PRs for W1 (#431); this is the state-truth data plane.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* Write wall-clock Date.now() to liveness slot in the backpressure-pause refresh\n\nLAST_LIVENESS_TIME_POSITION holds a wall-clock timestamp that the main thread\ncompares against Date.now() in deriveConnectionTruth. The backpressure-pause\nrefresh in sendPing was writing lastByteActivity (performance.now(), a monotonic\nclock relative to process start), so the slot would read as far in the past and\na healthy-but-paused link would be marked stale/down — the opposite of the\nrefresh's intent. Write Date.now() instead, matching every other liveness write.\n\nAddresses the gemini-code-assist critical review finding on #445.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-07-02T15:52:45Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/f379f162996d6f7562c945dd26be9b639d4a142d"
        },
        "date": 1783077279214,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 4.99,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 6.82,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 8.49,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 25.17,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 27.51,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 22.47,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 47.59,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 102.25,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 41.15,
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
          "id": "f379f162996d6f7562c945dd26be9b639d4a142d",
          "message": "Make replication connection state authoritative via shared memory (W1, #431) (#445)\n\n* Make replication connection state authoritative via shared memory (W1, #431)\n\nThe main thread infers each outbound (db,peer) subscription's connected\nstate from edge-triggered worker->main messages, which desync when a\nterminal/idle state is reached without a 'close' (open-but-idle wedge,\ninto the existing per-(db,peer) shared-memory Float64Array (slots 9-12:\nstate/liveness/error-code/error-time). The main thread reads it as truth:\ncluster_status reports the accurate connected plus a new lastConnectionError\n(#214), and reconcileWorkers corrects the inferred flag against it, feeding\nthe existing wedge recovery.\n\nconnected = CONNECTED state AND fresh liveness, so a worker that died or\nwedged without writing DOWN still reads down once liveness goes stale.\nLiveness is written at the NODE_NAME handshake, on pong, and on received\ndata; a backpressure pause refreshes it (matching shouldTerminateIdlePing's\npauseReasons exemption). LIVENESS_STALE_MS derives from PING_TIMEOUT.\n\nFirst of two PRs for W1 (#431); this is the state-truth data plane.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* Write wall-clock Date.now() to liveness slot in the backpressure-pause refresh\n\nLAST_LIVENESS_TIME_POSITION holds a wall-clock timestamp that the main thread\ncompares against Date.now() in deriveConnectionTruth. The backpressure-pause\nrefresh in sendPing was writing lastByteActivity (performance.now(), a monotonic\nclock relative to process start), so the slot would read as far in the past and\na healthy-but-paused link would be marked stale/down — the opposite of the\nrefresh's intent. Write Date.now() instead, matching every other liveness write.\n\nAddresses the gemini-code-assist critical review finding on #445.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-07-02T15:52:45Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/f379f162996d6f7562c945dd26be9b639d4a142d"
        },
        "date": 1783162678390,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.16,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 6.35,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 7.48,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.38,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 18.28,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 29.75,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.23,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 107.95,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 43.5,
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
          "id": "bcd9c8f54156141e9136bb52f81c1efeaa245dd0",
          "message": "feat: Sync Core (#519)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-07-04T18:36:06Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/bcd9c8f54156141e9136bb52f81c1efeaa245dd0"
        },
        "date": 1783249347323,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.25,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 6.38,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 7.27,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.43,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 18.28,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.74,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 29.15,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 107.25,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 33.91,
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
          "id": "bcd9c8f54156141e9136bb52f81c1efeaa245dd0",
          "message": "feat: Sync Core (#519)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-07-04T18:36:06Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/bcd9c8f54156141e9136bb52f81c1efeaa245dd0"
        },
        "date": 1783338713499,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.03,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 6.49,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 8.13,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.28,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 18.31,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.44,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 29.81,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 110.3,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 44.52,
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
          "id": "795d5cd24012feba06300ff535a1f0b63a9b0307",
          "message": "feat(replication): expose connection-truth liveness age in cluster_status (#431)\n\ncluster_status already reports the shared-memory connection truth (connected\noverride + lastConnectionError, from #445). Add the missing piece: lastLiveness,\nthe wall-clock of the link's last proof-of-life (handshake/pong/receive stamp).\nOperators — and the W1 watchdog-demotion soak — need to see how fresh the truth\nbehind `connected` is, distinguishing an actively-alive link from one nearing\nthe staleness window.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-07-06T04:17:25Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/795d5cd24012feba06300ff535a1f0b63a9b0307"
        },
        "date": 1783423241708,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 4.53,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 6.58,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 8.56,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 16.23,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 17.61,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.13,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 27.89,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 103.66,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 33.73,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Lavinia",
            "username": "ldt1996",
            "email": "lavinia@harperdb.io"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "9af593e81ed571b369635fcdc71bd5e273d8a84b",
          "message": "fix(replication): bound the blob send path under backpressure (#534)\n\n* fix(replication): bound blob-send concurrency and sweep orphan blob streams every 60s\n\n* fix(replication): resolve writer drain wait on close, guard callback pushes with wsClosed, floor the sweep interval (review)",
          "timestamp": "2026-07-07T18:06:48Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/9af593e81ed571b369635fcdc71bd5e273d8a84b"
        },
        "date": 1783508448617,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 4.9,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 5.78,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 6.55,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 16.47,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 22.19,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.07,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 29.95,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 34.64,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 119.88,
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
          "id": "e40e8ba4c90bd9395ea4cd33d30866942c7b8883",
          "message": "fix(replication): harden closeOnInboundMessageError logging (PR #511 review)\n\nGemini findings: guard the logger access fully (the log must never\nprevent the close) and make the decode-error log readable when the\ntable decoder is unknown.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-01T22:58:49Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/e40e8ba4c90bd9395ea4cd33d30866942c7b8883"
        },
        "date": 1783682529610,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.19,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 6.2,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 7.33,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.43,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 18.49,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.7,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 30.06,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 43.52,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 96.88,
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
          "id": "c5850bde98a0fbb66ae55a8734761e7f5b49cd1f",
          "message": "test: guard every HARPER_BUILTIN_COMPONENTS entry has a defaultConfig.yaml key\n\nPer PR #560 review: nothing previously enforced that a built-in\ncomponent registered in bin/harper.js actually has a matching key in\nstatic/defaultConfig.yaml, so componentLoader.ts's\n`if (!config[componentName]) continue;` can silently skip loading any\nfuture built-in the same way it did secretCustody. Verified this test\nfails with the pre-fix defaultConfig.yaml (missing secretCustody key)\nand passes with it restored.",
          "timestamp": "2026-07-10T20:42:20Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/c5850bde98a0fbb66ae55a8734761e7f5b49cd1f"
        },
        "date": 1783766756179,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 4.96,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 6.76,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 7.99,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 16.84,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 17.63,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.3,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 29.35,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 82.86,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 34.85,
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
          "id": "7f4e30a40cfda9e0c4adc24b09a8113897b59a08",
          "message": "chore: bump version to 5.2.0-alpha.3\n\nBump core submodule to latest main (31de6a3b).",
          "timestamp": "2026-07-11T22:57:01Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/7f4e30a40cfda9e0c4adc24b09a8113897b59a08"
        },
        "date": 1783853366745,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 4.51,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 6.32,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 7.28,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 24.41,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 31.61,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 16.12,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 30.86,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 85.58,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 33.92,
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
          "id": "7f4e30a40cfda9e0c4adc24b09a8113897b59a08",
          "message": "chore: bump version to 5.2.0-alpha.3\n\nBump core submodule to latest main (31de6a3b).",
          "timestamp": "2026-07-11T22:57:01Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/7f4e30a40cfda9e0c4adc24b09a8113897b59a08"
        },
        "date": 1783941830673,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.32,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 6.88,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 8.1,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 18.54,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.6,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 16.17,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 30.86,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 113.52,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 49.65,
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
          "id": "3215f3357c9325eaf3062096eb39853452f4027d",
          "message": "fix: tighten engines.node to match re2's install-time requirement\n\nre2 (and its node-gyp source-build fallback) requires\n^22.22.2 || ^24.15.0 || >=26.0.0, narrower than the root package.json's\n^22.18.0 || >=24.0.0. Node 22.18.0-22.22.1 and 24.0.0-24.14.x satisfy\nthe old range but not re2's, so an install on one of those patch\nversions would warn/fail. Tighten the declared range to match.",
          "timestamp": "2026-07-14T01:24:10Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/3215f3357c9325eaf3062096eb39853452f4027d"
        },
        "date": 1784026735196,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.73,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 13.82,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 16.84,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 42.96,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 46.54,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 42.5,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 85.35,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 74.43,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 188.52,
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
          "id": "0b49587f56d4bf6fb55703c0818b47ee2af610cf",
          "message": "Constrain replication mesh when the system database is replicated (#572)\n\n* spike: directional hdb_nodes self-record to constrain mesh under system replication\n\nDerive a directional replicates object (sendsTo/receivesFrom, per-database) for a\nnode's own hdb_nodes record from its config routes instead of a blanket replicates:true.\nLets the system db replicate for discovery/config propagation while user-db connections\nstay on the configured topology, enforced by the existing #498 gates.\n\nIncludes two integration repros (3-tier chain; per-database opposite directions).\nValidated by hot-patching dist; see repro output in session.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* Constrain replication mesh when the system database is replicated\n\nDerive a directional hdb_nodes self-record from a node's config routes\n(computeSelfReplicates) instead of a blanket replicates:true, so `system`\ncan replicate for discovery/config propagation without every aggregation\nnode opening direct connections to every discovered peer. The existing\n#498 gates consult the propagated directional record; opt-in, so nodes\nwith no directional routes keep legacy full-mesh.\n\n- computeSelfReplicates + getConfiguredRoutes extracted/module-scoped; opt-in\n  (only when >=1 directional route), explicit-none yields empty (not true).\n- ensureThisNode compares replicates structurally so config/deploy reloads refresh it.\n- setNode/addNodeBack derive the self-record the same way and drop the blanket\n  sends:true on directional peer records (was short-circuiting the allow-list).\n- mergeReconstructedNode preserves a peer's last-known directional replicates\n  through a transient decode miss (no topology widening).\n- Unit tests (computeSelfReplicates/mergeReconstructedNode); integration tests\n  for transitive 3-tier, per-db opposite directions, and excluded-peer churn.\n- DESIGN.md documents the mechanism and its boundaries.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix: guard non-array sendsTo/receivesFrom, fix lint\n\n- computeSelfReplicates: Array.isArray guard on rep.sendsTo/receivesFrom\n  instead of `|| []` — route config comes from YAML and isn't schema-\n  validated, so a misconfigured non-array value would throw in the\n  for...of and crash boot. Matches the existing guard in\n  routeEntriesIncludePeer. Per gemini-code-assist review on PR #572.\n- systemDbPerDbDirectionRepro.test.mjs: remove unused nodeM destructure\n  (lint failure).\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix: address PR #572 review (Chris Barber)\n\nTwo directional-routing regressions found in review:\n\n- knownNodes.ts scanNodesForSubscription: the reconstruct-merge guard was\n  `!node.url || node.shard === undefined`, but on an UNSHARDED cluster every\n  real decoded record has shard === undefined, so mergeReconstructedNode ran\n  over real records and reverted a freshly-decoded `replicates` to a stale\n  in-memory value during a copyApply base-copy reload (harper-pro#489) —\n  dropping user-db records for a peer that widened, over-connecting to one\n  that narrowed. Gate strictly on `!node.url`: a real record always has a\n  url, so only true reconstruct descriptors are merged.\n\n- replicationConnection.ts dynamic send-authority gate: used a strict\n  `sub.source === thisNode && sub.database === databaseName`. A\n  full-replication neighbor's directional self-record advertises\n  `receivesFrom: [{ source }]` with NO database (wildcard), so once a node\n  was opted-in, its full-replication neighbors' per-database subscriptions\n  were rejected (close 1008) whenever the sender fell to the dynamic gate.\n  Delegate to routeEntriesIncludePeer (absent source/database = wildcard),\n  matching the receive-side gate.\n\n- Adds an integration test driving an opted-in full-replication neighbor\n  through the dynamic send path.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: KrAIs <kris@harperdb.io>\nCo-authored-by: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-07-15T02:01:17Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/0b49587f56d4bf6fb55703c0818b47ee2af610cf"
        },
        "date": 1784112962320,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.41,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 6.79,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 7.64,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.79,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 18.77,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 26.94,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 57.85,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 128.53,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 53.08,
            "unit": "ms"
          }
        ]
      }
    ]
  }
}