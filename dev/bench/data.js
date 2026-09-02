window.BENCHMARK_DATA = {
  "lastUpdate": 1788335686191,
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
          "id": "730a862836c3eb6b398d16e8f87093715914ecea",
          "message": "feat: Sync Core (#586)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-07-15T15:01:47Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/730a862836c3eb6b398d16e8f87093715914ecea"
        },
        "date": 1784199879851,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10725.88,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 25222.57,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 21640.54,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 8630.68,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5742.09,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2802.87,
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
          "id": "6c539c3faed46451987a4468cae49f9b375e36a6",
          "message": "Release v5.2.0-alpha.6",
          "timestamp": "2026-07-17T00:34:03Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/6c539c3faed46451987a4468cae49f9b375e36a6"
        },
        "date": 1784285610176,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10036.14,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 25168.75,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 21681.73,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 10301.98,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 8403.37,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 3620.05,
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
          "id": "57047faf6419b0073d8d2149017e046a87191286",
          "message": "fix: rename replication log redaction from registryAuth to credentials (#583)\n\nCore PR harper#1797 reshapes deploy_component's credential field from\nregistryAuth to credentials. logRedaction.ts masked tokens by keying on\noperation.registryAuth, so after that rename the mask would silently stop\nmatching anything.\n\nCo-authored-by: Claude Sonnet <noreply@anthropic.com>",
          "timestamp": "2026-07-17T20:08:31Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/57047faf6419b0073d8d2149017e046a87191286"
        },
        "date": 1784371822624,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 9929.18,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 26475.69,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 22060.6,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 10535.85,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 7341.58,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 3168.58,
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
          "id": "57047faf6419b0073d8d2149017e046a87191286",
          "message": "fix: rename replication log redaction from registryAuth to credentials (#583)\n\nCore PR harper#1797 reshapes deploy_component's credential field from\nregistryAuth to credentials. logRedaction.ts masked tokens by keying on\noperation.registryAuth, so after that rename the mask would silently stop\nmatching anything.\n\nCo-authored-by: Claude Sonnet <noreply@anthropic.com>",
          "timestamp": "2026-07-17T20:08:31Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/57047faf6419b0073d8d2149017e046a87191286"
        },
        "date": 1784458265711,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10495.26,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 26839.74,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 22635.53,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 10265.68,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 8156.07,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 3216.41,
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
          "id": "11297922f796269041e695279cc5c73db56c4283",
          "message": "feat: Sync Core (#595)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-07-20T08:12:40Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/11297922f796269041e695279cc5c73db56c4283"
        },
        "date": 1784546552358,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10078.02,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 27475.53,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 22855.62,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 10216.91,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 6709.46,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 3272.94,
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
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "39afbc461fcd7c2ca5ed65a5de5c35319c1da30f",
          "message": "chore(deps): update all non-major dependencies",
          "timestamp": "2026-07-21T02:11:13Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/39afbc461fcd7c2ca5ed65a5de5c35319c1da30f"
        },
        "date": 1784631842220,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10732.88,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 26290.58,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 21245.78,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 9814.67,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 8040.72,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 3092.46,
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
          "id": "59b41f014d01ea692a520edce982928bc9f7e4bc",
          "message": "Release v5.2.0-beta.2",
          "timestamp": "2026-07-22T02:53:27Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/59b41f014d01ea692a520edce982928bc9f7e4bc"
        },
        "date": 1784718214910,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 12285.55,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 26343.69,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 22635.42,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 11508.2,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 9271.5,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 3290.39,
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
          "id": "64439476c7cc3e6c73ab612f04c0f0b820be4a91",
          "message": "build(core): pick up the replication resume-cursor blocking-write fix\n\nPoints the core submodule at the fix for the apply loop's resume-cursor\nwrite, which blocked the worker event loop for up to 101s under RocksDB\nwrite stall and got the subscription torn down by the sender's receive\nwatchdog.\n\nRefs #603\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>",
          "timestamp": "2026-07-21T17:37:19Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/64439476c7cc3e6c73ab612f04c0f0b820be4a91"
        },
        "date": 1784804903473,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 12968.01,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 26673.45,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 21857.47,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 10740.21,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 7278.8,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2353.84,
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
          "id": "86f2955e70031e19a793d2f6420acb7a384409cf",
          "message": "feat: Sync Core (#607)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-07-23T14:53:24Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/86f2955e70031e19a793d2f6420acb7a384409cf"
        },
        "date": 1784891218854,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10659.06,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 26670.35,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 22013.16,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 8922.99,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5747.3,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2133.83,
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
          "id": "86f2955e70031e19a793d2f6420acb7a384409cf",
          "message": "feat: Sync Core (#607)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-07-23T14:53:24Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/86f2955e70031e19a793d2f6420acb7a384409cf"
        },
        "date": 1784977101180,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10957.72,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 26077.93,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 12091.67,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7157.74,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5240.98,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2059.83,
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
          "id": "86f2955e70031e19a793d2f6420acb7a384409cf",
          "message": "feat: Sync Core (#607)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-07-23T14:53:24Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/86f2955e70031e19a793d2f6420acb7a384409cf"
        },
        "date": 1785063292617,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10719.65,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 27921.06,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 23014.42,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 10389.46,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 7791.82,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2710.59,
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
          "id": "1aa440f8c89338e49e89a8468e536c862acb2bfe",
          "message": "feat: Sync Core (#610)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-07-27T04:30:32Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/1aa440f8c89338e49e89a8468e536c862acb2bfe"
        },
        "date": 1785151611558,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 13808.65,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 27682.47,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 22707.23,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 11119.46,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 6245.8,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2702.38,
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
          "id": "162fb5f496b34af9a96cb88ebf76d4b82b762d47",
          "message": "chore(deps): update pin digests (#620)\n\nCo-authored-by: renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>",
          "timestamp": "2026-07-27T17:49:10Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/162fb5f496b34af9a96cb88ebf76d4b82b762d47"
        },
        "date": 1785237127850,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 13920.81,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 26840.75,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 22324.68,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 11012.03,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5733.07,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2834.55,
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
          "id": "e01bc06e4eb4e91d4911d03d32d4821f38410bbd",
          "message": "fix(test): address review feedback on static redeploy regression anchor\n\n- ESM-safe fallback for import.meta.dirname (was CJS-only module.path)\n- Assign started cluster nodes by index (not push) so origin/replica\n  identity survives even if the two startHarper calls resolve out of\n  order, while still recording partially-started nodes for teardown\n- Guard test 3 against test 2 having failed before setting ctx.snapshots\n- Assert the replica's redeployed pages are actually 200 after its\n  restart, not just fetched and logged (restart:true test previously\n  proved nothing about the routes it claims to fix)\n- Move the suite to the top of the file, utility functions below\n  (function declarations hoist) per review feedback\n- Raise hook/test timeouts to clear the worst-case retry/poll budgets\n  used inside them, so a legitimately-slow cluster fails with the\n  helper's own descriptive error instead of a generic node:test timeout\n\nAddresses gemini-code-assist, claude, dawsontoth, and the pending\nself-review's feedback on #614.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-28T11:38:53Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/e01bc06e4eb4e91d4911d03d32d4821f38410bbd"
        },
        "date": 1785323849883,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10588.1,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 21734.57,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 16863.08,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7648.43,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4924.14,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2726.64,
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
          "id": "63e0e1c469b58d69cefd5c57c68c4d27e890c1ec",
          "message": "Release v5.2.0-beta.3",
          "timestamp": "2026-07-29T12:39:17Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/63e0e1c469b58d69cefd5c57c68c4d27e890c1ec"
        },
        "date": 1785409664566,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 14424.28,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 25595.64,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 22219.91,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 10165.56,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5620.17,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2448.03,
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
          "id": "41d4401564f6a4b4134511ad21024a7793810de4",
          "message": "Release v5.2.0-beta.4",
          "timestamp": "2026-07-31T03:37:52Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/41d4401564f6a4b4134511ad21024a7793810de4"
        },
        "date": 1785496656238,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 12038.2,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 26861.26,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 22064.04,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 11666.78,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 7747.49,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2376.19,
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
          "id": "57f28f9cb719fd79c7ee3bef6fe5ee229573baa9",
          "message": "Release v5.2.0",
          "timestamp": "2026-08-01T02:10:55Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/57f28f9cb719fd79c7ee3bef6fe5ee229573baa9"
        },
        "date": 1785581726084,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 12129.99,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 27428.7,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 21954.92,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 9667.72,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5414.63,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2667.92,
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
          "id": "57f28f9cb719fd79c7ee3bef6fe5ee229573baa9",
          "message": "Release v5.2.0",
          "timestamp": "2026-08-01T02:10:55Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/57f28f9cb719fd79c7ee3bef6fe5ee229573baa9"
        },
        "date": 1785668196754,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 12754.57,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 25746.77,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 21926.61,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 11027.93,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5644.54,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2073.68,
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
          "id": "57f28f9cb719fd79c7ee3bef6fe5ee229573baa9",
          "message": "Release v5.2.0",
          "timestamp": "2026-08-01T02:10:55Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/57f28f9cb719fd79c7ee3bef6fe5ee229573baa9"
        },
        "date": 1785758085042,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 2962.81,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 7286.93,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 9115.69,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 4577.28,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 3481.52,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1019.77,
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
          "id": "24aca7f581b44690162e72b3c1d293d67087eebb",
          "message": "feat: Sync Core (#639)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-08-03T12:08:49Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/24aca7f581b44690162e72b3c1d293d67087eebb"
        },
        "date": 1785842427657,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 12016.9,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 25982.76,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 20248.78,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 10147.22,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5169.2,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1989.95,
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
          "id": "0042b84b8bea75314e41f9c9a68243c7aae86165",
          "message": "Merge pull request #625 from HarperFast/ci/bump-ai-review-prompts-224c2ad\n\nchore(ci): bump ai-review-prompts to 224c2ad (#80 week-of-07-20 calibration)",
          "timestamp": "2026-08-04T18:10:19Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/0042b84b8bea75314e41f9c9a68243c7aae86165"
        },
        "date": 1785928948939,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10498.31,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 25305.68,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 20444.71,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6609.69,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4370.04,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1800.32,
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
          "id": "dcfd505bb675f0ddc6ac5ae5f66525c3959477b4",
          "message": "ci: fix retry.sh unbound-variable edge case, raise integration job budgets\n\nIndependent pre-push review found two issues:\n- retry.sh read $1 as the label before checking $#, so a zero-arg call\n  hit bash's \"unbound variable\" error under set -u instead of the\n  intended usage diagnostic. Check $# first.\n- run-integration-tests/run-cluster-tests kept their pre-existing\n  15-minute timeout even though each now runs two sequential retry.sh\n  calls that can burn up to 3 minutes of backoff apiece before\n  succeeding on the last attempt. Raise both to 25 minutes.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-30T16:00:42Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/dcfd505bb675f0ddc6ac5ae5f66525c3959477b4"
        },
        "date": 1786015687712,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10614.84,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 21138.93,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 14347.11,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 5104.76,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 3791.3,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1473.54,
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
          "id": "31ffba8b650eec827dda8752e16cf92cdcc5583e",
          "message": "Clarify audit-tail churn test coverage\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-06T19:24:43Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/31ffba8b650eec827dda8752e16cf92cdcc5583e"
        },
        "date": 1786099912463,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 11648.87,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 25151.42,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 19811.29,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6024.04,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4221.71,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1558.97,
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
          "id": "2aed45a9628f407926a891d49d7c6dc08b47af43",
          "message": "Release v5.2.1",
          "timestamp": "2026-08-07T19:48:34Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/2aed45a9628f407926a891d49d7c6dc08b47af43"
        },
        "date": 1786185487201,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 12558.87,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 26158.56,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 19078.47,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6220.73,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4753.13,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1893.43,
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
          "id": "2aed45a9628f407926a891d49d7c6dc08b47af43",
          "message": "Release v5.2.1",
          "timestamp": "2026-08-07T19:48:34Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/2aed45a9628f407926a891d49d7c6dc08b47af43"
        },
        "date": 1786359677040,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 14220.45,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 26371.84,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 20283.9,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6392.25,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4462.83,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1527.17,
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
          "id": "2aed45a9628f407926a891d49d7c6dc08b47af43",
          "message": "Release v5.2.1",
          "timestamp": "2026-08-07T19:48:34Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/2aed45a9628f407926a891d49d7c6dc08b47af43"
        },
        "date": 1786445319285,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 12573.85,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 25681.56,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 20744.37,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 5827.19,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4805.1,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1716.02,
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
          "id": "ea47bc7c9e4cdb783980150bc8c6cddfcb2dc5bb",
          "message": "chore(deps): update all non-major dependencies (#680)\n\nCo-authored-by: renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>",
          "timestamp": "2026-08-11T22:49:26Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/ea47bc7c9e4cdb783980150bc8c6cddfcb2dc5bb"
        },
        "date": 1786532036570,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10334.92,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 25808.25,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 18673.76,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6468.7,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4305.49,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1897.59,
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
          "id": "26f3c3dbf523b52a729e8d5fb142b1c5b87ac649",
          "message": "feat: Sync Core (#689)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-08-12T22:50:35Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/26f3c3dbf523b52a729e8d5fb142b1c5b87ac649"
        },
        "date": 1786618503575,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 15726.92,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 24092.99,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 21631.18,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6037.86,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 3927.47,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1737.19,
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
          "id": "550d224520e488cec6f8c7f8cf4f0ba41d47979e",
          "message": "Release v5.2.2",
          "timestamp": "2026-08-14T02:24:23Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/550d224520e488cec6f8c7f8cf4f0ba41d47979e"
        },
        "date": 1786704896872,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 11516.99,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 26724.81,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 21454.81,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6179.64,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 3852.41,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1689.97,
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
          "id": "550d224520e488cec6f8c7f8cf4f0ba41d47979e",
          "message": "Release v5.2.2",
          "timestamp": "2026-08-14T02:24:23Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/550d224520e488cec6f8c7f8cf4f0ba41d47979e"
        },
        "date": 1786789852441,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 11068.34,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 26070.24,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 21685.36,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7451.77,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4950.91,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2111.4,
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
          "id": "550d224520e488cec6f8c7f8cf4f0ba41d47979e",
          "message": "Release v5.2.2",
          "timestamp": "2026-08-14T02:24:23Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/550d224520e488cec6f8c7f8cf4f0ba41d47979e"
        },
        "date": 1786876560008,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10232.22,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 25103.22,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 15152.42,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6113.67,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4929.51,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1787.34,
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
          "id": "540b353f55a1869347e37a02c01c98e951a7a17c",
          "message": "feat: Sync Core (#705)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-08-17T02:18:56Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/540b353f55a1869347e37a02c01c98e951a7a17c"
        },
        "date": 1786963123293,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 12038.47,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 26308.56,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 20029.34,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6770.21,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4929.83,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1964.21,
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
          "id": "0e27cb2ae0f8f6e554459ef872e9bd0fb09d2fe9",
          "message": "Add companion-check workflow: coordinated PRs auto-merge once their harper companion lands (#704)\n\n* ci: companion-check gate for PRs dependent on companion PRs (e.g. harper core)\n\nAdds a workflow posting a companion-check commit status driven by\nDepends-on: markers in PR bodies, so a coordinated harper-pro PR can be\napproved and armed for auto-merge, then merge automatically once its\nharper companion lands. Merging such a PR fires the existing sync_core\nrepository_dispatch so the core pointer is re-pointed at harper main\npromptly instead of at the nightly run.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* ci: harden companion-check per cross-model review\n\nFail closed on unparseable markers, support repo#N shorthand, bound and\ndedupe refs, isolate per-dep/per-PR errors, restrict the cross-repo\ntoken to same-org refs, guard sweep/event races, and skip no-marker PRs\nin the cron sweep.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* ci: fail closed on partial markers, heal statuses in sweep, harden sync\n\nRound-2 review fixes matching the documentation-repo copy, plus\nharper-pro-specific ones: split the closed-event concurrency group so an\nedit to a merged PR cannot cancel a pending sync_core dispatch, drop the\ndead case variant in the normalize-core condition, and make Sync Core\nreset core's branch tracking to main so a merged core:set-branch\noverride cannot wedge the nightly or dispatched sync. Adds the\nself-contained node test harness for the embedded script.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* ci: run companion-check tests in runLinter; hedge not-found diagnostic\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* ci: definitive 404s fail closed; align normalize grammar; guard sync reset to main\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* test: stateful script-block extraction and per-scenario fetch isolation (review feedback)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-08-18T02:44:53Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/0e27cb2ae0f8f6e554459ef872e9bd0fb09d2fe9"
        },
        "date": 1787049464748,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 12719.26,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 25847.03,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 21427.14,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 5797.15,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4524.35,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1592.46,
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
          "id": "23f3f46d5e252e63ed4116ff62f07b822ec72390",
          "message": "Release v5.2.3",
          "timestamp": "2026-08-19T02:09:53Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/23f3f46d5e252e63ed4116ff62f07b822ec72390"
        },
        "date": 1787135926560,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 12740.5,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 18403.15,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 16555.78,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 5888.32,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4065.22,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1769.13,
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
          "id": "84403ffb6bf2b9da23afc9ff120fa636e15f4a1f",
          "message": "fix(replication): fail loud on oversized frame, with backoff escalation and copy-batch capping (#713)",
          "timestamp": "2026-08-20T04:09:06Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/84403ffb6bf2b9da23afc9ff120fa636e15f4a1f"
        },
        "date": 1787222419784,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 9631.84,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 16731.05,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 12725.61,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7376.58,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4479.88,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1689.83,
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
          "id": "bc55bf26a54a1e2cd7ba5204014f31e9551bad4a",
          "message": "Release v5.2.4",
          "timestamp": "2026-08-20T21:15:15Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/bc55bf26a54a1e2cd7ba5204014f31e9551bad4a"
        },
        "date": 1787308698068,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10346.87,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 19285.21,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 14632.02,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6124.99,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4312.87,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1873.66,
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
          "id": "d2a193fab1840bbe9b11c8e6a43c471d6b72406d",
          "message": "Stabilize copy-gap cursor banking regression coverage (#739)\n\n* Stabilize copy-gap cursor banking regression\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n* Update copy-gap workflow guard after suite rename\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n---------\n\nCo-authored-by: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-21T22:01:39Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/d2a193fab1840bbe9b11c8e6a43c471d6b72406d"
        },
        "date": 1787394818299,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10043.85,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 26915.73,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 21292.8,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7886.54,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5006.95,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1715.44,
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
          "id": "d2a193fab1840bbe9b11c8e6a43c471d6b72406d",
          "message": "Stabilize copy-gap cursor banking regression coverage (#739)\n\n* Stabilize copy-gap cursor banking regression\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n* Update copy-gap workflow guard after suite rename\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n---------\n\nCo-authored-by: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-21T22:01:39Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/d2a193fab1840bbe9b11c8e6a43c471d6b72406d"
        },
        "date": 1787481015499,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 13279.96,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 26731.59,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 22128.65,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7178.41,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5008.03,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2259.4,
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
          "id": "d2a193fab1840bbe9b11c8e6a43c471d6b72406d",
          "message": "Stabilize copy-gap cursor banking regression coverage (#739)\n\n* Stabilize copy-gap cursor banking regression\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n* Update copy-gap workflow guard after suite rename\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n---------\n\nCo-authored-by: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-21T22:01:39Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/d2a193fab1840bbe9b11c8e6a43c471d6b72406d"
        },
        "date": 1787568013305,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10834.78,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 27548.57,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 21947.16,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 8335.43,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5400.37,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2343.38,
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
          "id": "045370ca2fab6f2ae46874b3992ad7d81a3267f9",
          "message": "Release v5.2.5",
          "timestamp": "2026-08-25T05:23:38Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/045370ca2fab6f2ae46874b3992ad7d81a3267f9"
        },
        "date": 1787654292494,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 13222.94,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 26021.23,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 16104.73,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 8898.09,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 3895.32,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2027.52,
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
          "id": "546ec7bcc37f58a56cc430966cdf59736d37f9bb",
          "message": "feat: Sync Core (#765)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-08-25T23:32:10Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/546ec7bcc37f58a56cc430966cdf59736d37f9bb"
        },
        "date": 1787741045184,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10078.99,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 25942.01,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 20336.64,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6632.39,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 3463.66,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1821.61,
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
          "id": "fe108481ad21103b4b2dffbe41c357d9e204b656",
          "message": "Route dependency-manifest reviews to a single code owner (#758)\n\n* Route dependency-manifest reviews to a single code owner\n\nGitHub auto-requests @HarperFast/developers when a PR is opened, so a\ndependency bump lands in every team member's review queue for a lockfile\ndiff. Scope package.json and package-lock.json to one owner; the last\nmatching pattern wins, so everything else still routes to the team.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>\n\n* Anchor dependency CODEOWNERS patterns\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n---------\n\nCo-authored-by: Claude Opus 5 <noreply@anthropic.com>\nCo-authored-by: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-26T11:57:10Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/fe108481ad21103b4b2dffbe41c357d9e204b656"
        },
        "date": 1787839034378,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 12588.96,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 27069.89,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 21496.69,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7070.18,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5077.14,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2476.54,
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
          "id": "d792a44a51ed09ca5b888065d709e4e846f040dd",
          "message": "ci: adopt ai-review-prompts fleet defaults and new review lenses (#766)\n\n* ci: adopt ai-review-prompts fleet defaults and new review lenses\n\nBump every ai-review-prompts pin to 4632c5d: claude-sonnet-5 model,\n--effort xhigh, 96-turn review budget (issue-to-pr 100), 30m timeouts\n(#89), the sibling-implementations and cannot-fail-test lenses (#88),\nand the week-of-08-10/08-17 calibration prompt edits (#85/#87).\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01S94XethbGXpAb4DRKMD4kt\n\n* ci: adopt ai-review-prompts #90 cost gates (pin be549ad) + ready_for_review trigger\n\nDraft PRs skip review until flipped ready (label still opts one in),\nmechanical diffs skip pre-run, reasoning effort scales with diff size\n(60/high, 1500/xhigh, else max), synchronize runs debounce 120s.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01S94XethbGXpAb4DRKMD4kt\n\n* ci: admit ready_for_review on label-opted PRs in opt-in mode\n\nkriszyp review finding on the pin-bump PR: with *_ALWAYS_ON unset, the\ncaller gate admitted only labeled events, so a PR opted in by label\nwhile draft never resumed review when flipped ready — the event died at\nthe caller gate. Admit ready_for_review when the opt-in label is still\npresent.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01S94XethbGXpAb4DRKMD4kt\n\n* ci: keep ineligible runs out of the review concurrency group\n\nkriszyp review finding: workflow-level cancel-in-progress fires before\njob if:, so in opt-in mode an ineligible event (a push, or a ready-flip\nwithout the opt-in label) cancels an in-flight label-triggered review\nand then skips — silently losing the requested review. Ineligible runs\nnow take a unique run_id group and can never cancel an eligible one;\neligible runs keep cancelling each other (the debounce contract).\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01S94XethbGXpAb4DRKMD4kt\n\n* ci: only the provider's own label makes a labeled run eligible\n\nReview finding (Codex + kriszyp, independently): the eligibility\npredicate admitted every labeled event, so in opt-in mode an unrelated\nlabel applied mid-review joined the eligible concurrency group,\ncancelled the running review, and the replacement then failed the\nreusable's exact-label gate — no completed review. The same\nunrelated-label cancellation existed in always-on mode before this\nseries (any labeled event shared the group and authorize then skipped).\n\nThe labeled branch now requires the provider's own label, in both the\nconcurrency predicate and the review job gate, and unrelated-label\nevents are ineligible in both modes.\n\nEvent matrix (opt-in / always-on):\n- labeled(provider label): eligible / eligible — supersedes in-flight\n- labeled(other): ineligible / ineligible (was: cancelled + no review)\n- synchronize: ineligible / eligible\n- ready_for_review + label: eligible / eligible\n- ready_for_review, no label: ineligible / eligible\n- opened, reopened: ineligible / eligible\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01S94XethbGXpAb4DRKMD4kt\n\n* ci: ready_for_review runs review but never cancels\n\nkriszyp follow-up finding: the label-opted ready_for_review event sat\nin the shared eligible concurrency group, so on a bot-authored PR it\ncould cancel the trusted labeler's in-flight review and then be\nrejected by author-based authorization — no completed review. The\ncancelling set (concurrency predicate) now excludes ready_for_review;\nthe running set (job gate) keeps it, so trusted-author ready-flips\nstill review, without the power to cancel. Revisit if the reusable\ngains persisted-label authorization.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01S94XethbGXpAb4DRKMD4kt\n\n* ci: exclude ready_for_review from the always-on cancelling arm\n\nCodex follow-up on the ready-noncancelling fix: ready_for_review is a\nnon-labeled event, so the ALWAYS_ON arm of the concurrency predicate\nstill placed it in the shared cancelling group in always-on mode — a\nlabel-opted bot PR's ready-flip could cancel the labeler's in-flight\nreview and then fail author-based authorization. The cancelling set now\nexcludes ready_for_review in BOTH modes; the job gates are unchanged\n(ready-flips run review, in their own run_id group).\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01S94XethbGXpAb4DRKMD4kt\n\n---------\n\nCo-authored-by: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-08-27T17:16:53Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/d792a44a51ed09ca5b888065d709e4e846f040dd"
        },
        "date": 1787916378465,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 9959.86,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 24362.46,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 17521.59,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6949.1,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4565.55,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2339.76,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kyle Bernhardy",
            "username": "kylebernhardy",
            "email": "kyle@harperdb.io"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "cc5f7cf848bf34fe90bb9b1a0b2f33c0ac09b542",
          "message": "Prevent full-copy integration tests from leaking nodes (#778)\n\n* Always stop full-copy test nodes\n\n* Guard partial full-copy test starts",
          "timestamp": "2026-08-28T22:14:16Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/cc5f7cf848bf34fe90bb9b1a0b2f33c0ac09b542"
        },
        "date": 1787989689337,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 12877.77,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 25663.35,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 20765.89,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 9413.17,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 6192.6,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2391.04,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kyle Bernhardy",
            "username": "kylebernhardy",
            "email": "kyle@harperdb.io"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "cc5f7cf848bf34fe90bb9b1a0b2f33c0ac09b542",
          "message": "Prevent full-copy integration tests from leaking nodes (#778)\n\n* Always stop full-copy test nodes\n\n* Guard partial full-copy test starts",
          "timestamp": "2026-08-28T22:14:16Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/cc5f7cf848bf34fe90bb9b1a0b2f33c0ac09b542"
        },
        "date": 1788076208944,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 13346.52,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 26168.4,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 18037.32,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 9132.56,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4815.97,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2452.1,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kyle Bernhardy",
            "username": "kylebernhardy",
            "email": "kyle@harperdb.io"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "cc5f7cf848bf34fe90bb9b1a0b2f33c0ac09b542",
          "message": "Prevent full-copy integration tests from leaking nodes (#778)\n\n* Always stop full-copy test nodes\n\n* Guard partial full-copy test starts",
          "timestamp": "2026-08-28T22:14:16Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/cc5f7cf848bf34fe90bb9b1a0b2f33c0ac09b542"
        },
        "date": 1788163157995,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 13955.74,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 26586.58,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 21597.54,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 9641.54,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 6497.27,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2505.47,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "kriszyp",
            "username": "kriszyp",
            "email": "34054+kriszyp@users.noreply.github.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "b15fceb459203063dcc013a7de2f79e372d60cc9",
          "message": "feat: Sync Core",
          "timestamp": "2026-08-31T07:25:48Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/b15fceb459203063dcc013a7de2f79e372d60cc9"
        },
        "date": 1788249301859,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 12199.71,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 26363.17,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 22919.13,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 8999.8,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4871.03,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2465.48,
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
          "id": "e506fcb4253dc123ffc6ef50168fbaa35d462094",
          "message": "Automerge workflow actions only, gate the rest (#702)\n\n* chore(renovate): automerge workflow actions only, gate the rest\n\nAutomerge is scoped to the github-actions manager because PR CI runs the\nworkflows. No PR-triggered job builds Dockerfile, Dockerfile-gpu or\nDockerfile-openshift, so a repo-wide automerge would have landed base-image\nbumps — including the fully-pinned nvidia/cuda runtime — on a suite that never\ncompiled the image.\n\nMajors, 0.x minors, and the load-bearing dependency list never automerge, in\nstep with harper's policy. rocksdb-js is disabled outright; its own release\nworkflow proposes it.\n\nThe root manifest stays disabled (those follow core), but matchFileNames is\nexact-path, so nested manifests under integrationTests/ remain managed — the\ndescription now says root manifest rather than implying all npm dependencies.\nmatchFiles was the removed spelling and worked only through Renovate's\nconfig-migration shim.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>\n\n* Gate Renovate automerge on exercised workflows\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n* Separate tested action updates from release workflows\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n* Align Renovate automerge with required checks\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n* Clarify Renovate gate ownership\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n* Remove unit workflow from Renovate automerge\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n---------\n\nCo-authored-by: Claude Opus 5 <noreply@anthropic.com>\nCo-authored-by: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-09-01T19:12:37Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/e506fcb4253dc123ffc6ef50168fbaa35d462094"
        },
        "date": 1788335684448,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 11396.33,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 26576.69,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 22457.31,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 9732.97,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5038.3,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2310.64,
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
          "id": "730a862836c3eb6b398d16e8f87093715914ecea",
          "message": "feat: Sync Core (#586)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-07-15T15:01:47Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/730a862836c3eb6b398d16e8f87093715914ecea"
        },
        "date": 1784199888960,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.4,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 6.99,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 8.4,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.17,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 19.68,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 40,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 81.42,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 48.09,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 150.08,
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
          "id": "6c539c3faed46451987a4468cae49f9b375e36a6",
          "message": "Release v5.2.0-alpha.6",
          "timestamp": "2026-07-17T00:34:03Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/6c539c3faed46451987a4468cae49f9b375e36a6"
        },
        "date": 1784285613528,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.69,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 6.96,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 8.14,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.02,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 19.07,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 16.36,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 31.53,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 91.28,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 34.69,
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
          "id": "57047faf6419b0073d8d2149017e046a87191286",
          "message": "fix: rename replication log redaction from registryAuth to credentials (#583)\n\nCore PR harper#1797 reshapes deploy_component's credential field from\nregistryAuth to credentials. logRedaction.ts masked tokens by keying on\noperation.registryAuth, so after that rename the mask would silently stop\nmatching anything.\n\nCo-authored-by: Claude Sonnet <noreply@anthropic.com>",
          "timestamp": "2026-07-17T20:08:31Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/57047faf6419b0073d8d2149017e046a87191286"
        },
        "date": 1784371825851,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.33,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 6.87,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 7.98,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.65,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 18.64,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 19.65,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 42.78,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 128.55,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 44.1,
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
          "id": "57047faf6419b0073d8d2149017e046a87191286",
          "message": "fix: rename replication log redaction from registryAuth to credentials (#583)\n\nCore PR harper#1797 reshapes deploy_component's credential field from\nregistryAuth to credentials. logRedaction.ts masked tokens by keying on\noperation.registryAuth, so after that rename the mask would silently stop\nmatching anything.\n\nCo-authored-by: Claude Sonnet <noreply@anthropic.com>",
          "timestamp": "2026-07-17T20:08:31Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/57047faf6419b0073d8d2149017e046a87191286"
        },
        "date": 1784458269534,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.13,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 7.06,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 8.11,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.72,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 18.7,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.53,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 34.31,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 117,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 47,
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
          "id": "11297922f796269041e695279cc5c73db56c4283",
          "message": "feat: Sync Core (#595)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-07-20T08:12:40Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/11297922f796269041e695279cc5c73db56c4283"
        },
        "date": 1784546555812,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 4.91,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 7.25,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 9.5,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.63,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 18.48,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 30.61,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 69.39,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 122.5,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 48.34,
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
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "39afbc461fcd7c2ca5ed65a5de5c35319c1da30f",
          "message": "chore(deps): update all non-major dependencies",
          "timestamp": "2026-07-21T02:11:13Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/39afbc461fcd7c2ca5ed65a5de5c35319c1da30f"
        },
        "date": 1784631845588,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.35,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 8.76,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 11.26,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.87,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 18.79,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 16.44,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 32.01,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 39.75,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 131.25,
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
          "id": "59b41f014d01ea692a520edce982928bc9f7e4bc",
          "message": "Release v5.2.0-beta.2",
          "timestamp": "2026-07-22T02:53:27Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/59b41f014d01ea692a520edce982928bc9f7e4bc"
        },
        "date": 1784718218707,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.58,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 6.89,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 8.78,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.47,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 24.7,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.57,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 41.14,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 120.76,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 47.61,
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
          "id": "64439476c7cc3e6c73ab612f04c0f0b820be4a91",
          "message": "build(core): pick up the replication resume-cursor blocking-write fix\n\nPoints the core submodule at the fix for the apply loop's resume-cursor\nwrite, which blocked the worker event loop for up to 101s under RocksDB\nwrite stall and got the subscription torn down by the sender's receive\nwatchdog.\n\nRefs #603\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>",
          "timestamp": "2026-07-21T17:37:19Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/64439476c7cc3e6c73ab612f04c0f0b820be4a91"
        },
        "date": 1784804908119,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.33,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 7.93,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 10.31,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.13,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 18.86,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 33.4,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 68.52,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 182.07,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 60.1,
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
          "id": "86f2955e70031e19a793d2f6420acb7a384409cf",
          "message": "feat: Sync Core (#607)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-07-23T14:53:24Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/86f2955e70031e19a793d2f6420acb7a384409cf"
        },
        "date": 1784891222135,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.14,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 7.21,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 8.73,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 35.23,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 45.58,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 39.56,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 84.76,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 225.4,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 77.79,
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
          "id": "86f2955e70031e19a793d2f6420acb7a384409cf",
          "message": "feat: Sync Core (#607)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-07-23T14:53:24Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/86f2955e70031e19a793d2f6420acb7a384409cf"
        },
        "date": 1784977105795,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.58,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 36.59,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 41.38,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 47.28,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 68.31,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 47.81,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 100.06,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 226.63,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 89.14,
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
          "id": "86f2955e70031e19a793d2f6420acb7a384409cf",
          "message": "feat: Sync Core (#607)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-07-23T14:53:24Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/86f2955e70031e19a793d2f6420acb7a384409cf"
        },
        "date": 1785063296309,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 4.84,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 7.22,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 10.53,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 26.66,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 41.84,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 28.93,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 67.35,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 152.04,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 45.76,
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
          "id": "1aa440f8c89338e49e89a8468e536c862acb2bfe",
          "message": "feat: Sync Core (#610)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-07-27T04:30:32Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/1aa440f8c89338e49e89a8468e536c862acb2bfe"
        },
        "date": 1785151614752,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 4.73,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 6.99,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 9.61,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 19.34,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.57,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 36.26,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 79.28,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 154.75,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 50.31,
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
          "id": "162fb5f496b34af9a96cb88ebf76d4b82b762d47",
          "message": "chore(deps): update pin digests (#620)\n\nCo-authored-by: renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>",
          "timestamp": "2026-07-27T17:49:10Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/162fb5f496b34af9a96cb88ebf76d4b82b762d47"
        },
        "date": 1785237131251,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.09,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 6.57,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 7.96,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 18.5,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.85,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 41.71,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 86.14,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 128.01,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 49.52,
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
          "id": "e01bc06e4eb4e91d4911d03d32d4821f38410bbd",
          "message": "fix(test): address review feedback on static redeploy regression anchor\n\n- ESM-safe fallback for import.meta.dirname (was CJS-only module.path)\n- Assign started cluster nodes by index (not push) so origin/replica\n  identity survives even if the two startHarper calls resolve out of\n  order, while still recording partially-started nodes for teardown\n- Guard test 3 against test 2 having failed before setting ctx.snapshots\n- Assert the replica's redeployed pages are actually 200 after its\n  restart, not just fetched and logged (restart:true test previously\n  proved nothing about the routes it claims to fix)\n- Move the suite to the top of the file, utility functions below\n  (function declarations hoist) per review feedback\n- Raise hook/test timeouts to clear the worst-case retry/poll budgets\n  used inside them, so a legitimately-slow cluster fails with the\n  helper's own descriptive error instead of a generic node:test timeout\n\nAddresses gemini-code-assist, claude, dawsontoth, and the pending\nself-review's feedback on #614.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-28T11:38:53Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/e01bc06e4eb4e91d4911d03d32d4821f38410bbd"
        },
        "date": 1785323854206,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 6.97,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 13.99,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 16.3,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 41.84,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 44.54,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 37.59,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 76.46,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 56.23,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 143.7,
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
          "id": "63e0e1c469b58d69cefd5c57c68c4d27e890c1ec",
          "message": "Release v5.2.0-beta.3",
          "timestamp": "2026-07-29T12:39:17Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/63e0e1c469b58d69cefd5c57c68c4d27e890c1ec"
        },
        "date": 1785409667945,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.31,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 6.72,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 8.16,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.87,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 19.81,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 35.26,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 74.27,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 180.21,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 56.12,
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
          "id": "41d4401564f6a4b4134511ad21024a7793810de4",
          "message": "Release v5.2.0-beta.4",
          "timestamp": "2026-07-31T03:37:52Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/41d4401564f6a4b4134511ad21024a7793810de4"
        },
        "date": 1785496660154,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.22,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 7.48,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 9.6,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 19.14,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.74,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 22.48,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 49.68,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 58.48,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 219.42,
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
          "id": "57f28f9cb719fd79c7ee3bef6fe5ee229573baa9",
          "message": "Release v5.2.0",
          "timestamp": "2026-08-01T02:10:55Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/57f28f9cb719fd79c7ee3bef6fe5ee229573baa9"
        },
        "date": 1785581729944,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.35,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 7.69,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 10.47,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.37,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 18.95,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 40.78,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 82.41,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 56.88,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 133.15,
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
          "id": "57f28f9cb719fd79c7ee3bef6fe5ee229573baa9",
          "message": "Release v5.2.0",
          "timestamp": "2026-08-01T02:10:55Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/57f28f9cb719fd79c7ee3bef6fe5ee229573baa9"
        },
        "date": 1785668201576,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.47,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 6.94,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 8.02,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.81,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 25.61,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 45.83,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 95.04,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 231.09,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 62.66,
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
          "id": "57f28f9cb719fd79c7ee3bef6fe5ee229573baa9",
          "message": "Release v5.2.0",
          "timestamp": "2026-08-01T02:10:55Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/57f28f9cb719fd79c7ee3bef6fe5ee229573baa9"
        },
        "date": 1785758089421,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 37.3,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 19.94,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 22.48,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 98,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 87.8,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 71.02,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 139.92,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 547.33,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 225.06,
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
          "id": "24aca7f581b44690162e72b3c1d293d67087eebb",
          "message": "feat: Sync Core (#639)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-08-03T12:08:49Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/24aca7f581b44690162e72b3c1d293d67087eebb"
        },
        "date": 1785842431044,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.3,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 10.17,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 12.88,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.02,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 22.04,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 46.25,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 93.04,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 96.62,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 223.31,
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
          "id": "0042b84b8bea75314e41f9c9a68243c7aae86165",
          "message": "Merge pull request #625 from HarperFast/ci/bump-ai-review-prompts-224c2ad\n\nchore(ci): bump ai-review-prompts to 224c2ad (#80 week-of-07-20 calibration)",
          "timestamp": "2026-08-04T18:10:19Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/0042b84b8bea75314e41f9c9a68243c7aae86165"
        },
        "date": 1785928953416,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.78,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 8.13,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 9.65,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 49.93,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 58.13,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 59.49,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 118.69,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 311.06,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 115.66,
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
          "id": "dcfd505bb675f0ddc6ac5ae5f66525c3959477b4",
          "message": "ci: fix retry.sh unbound-variable edge case, raise integration job budgets\n\nIndependent pre-push review found two issues:\n- retry.sh read $1 as the label before checking $#, so a zero-arg call\n  hit bash's \"unbound variable\" error under set -u instead of the\n  intended usage diagnostic. Check $# first.\n- run-integration-tests/run-cluster-tests kept their pre-existing\n  15-minute timeout even though each now runs two sequential retry.sh\n  calls that can burn up to 3 minutes of backoff apiece before\n  succeeding on the last attempt. Raise both to 25 minutes.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-30T16:00:42Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/dcfd505bb675f0ddc6ac5ae5f66525c3959477b4"
        },
        "date": 1786015692142,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 8.53,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 12.56,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 16,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 73.21,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 80.01,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 59.7,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 110.2,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 207.43,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 345.85,
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
          "id": "31ffba8b650eec827dda8752e16cf92cdcc5583e",
          "message": "Clarify audit-tail churn test coverage\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-06T19:24:43Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/31ffba8b650eec827dda8752e16cf92cdcc5583e"
        },
        "date": 1786099916241,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.49,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 7.94,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 9.65,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 61.63,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 52.55,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 62.12,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 130.78,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 401.61,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 77.3,
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
          "id": "2aed45a9628f407926a891d49d7c6dc08b47af43",
          "message": "Release v5.2.1",
          "timestamp": "2026-08-07T19:48:34Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/2aed45a9628f407926a891d49d7c6dc08b47af43"
        },
        "date": 1786185491261,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.57,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 10.78,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 12.99,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 55.86,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 65.39,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 47.92,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 99.88,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 115.66,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 241.62,
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
          "id": "2aed45a9628f407926a891d49d7c6dc08b47af43",
          "message": "Release v5.2.1",
          "timestamp": "2026-08-07T19:48:34Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/2aed45a9628f407926a891d49d7c6dc08b47af43"
        },
        "date": 1786359680992,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.07,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 8.5,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 11.82,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 55.15,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 60.87,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 55.26,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 115.32,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 422.1,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 90.76,
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
          "id": "2aed45a9628f407926a891d49d7c6dc08b47af43",
          "message": "Release v5.2.1",
          "timestamp": "2026-08-07T19:48:34Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/2aed45a9628f407926a891d49d7c6dc08b47af43"
        },
        "date": 1786445323517,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.51,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 8.51,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 11.11,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 54.49,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 60.91,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 46.04,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 99.65,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 101.16,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 299.53,
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
          "id": "ea47bc7c9e4cdb783980150bc8c6cddfcb2dc5bb",
          "message": "chore(deps): update all non-major dependencies (#680)\n\nCo-authored-by: renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>",
          "timestamp": "2026-08-11T22:49:26Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/ea47bc7c9e4cdb783980150bc8c6cddfcb2dc5bb"
        },
        "date": 1786532041005,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.61,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 11.33,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 13.17,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 59.05,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 64.48,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 56.06,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 121.47,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 318.98,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 80.25,
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
          "id": "26f3c3dbf523b52a729e8d5fb142b1c5b87ac649",
          "message": "feat: Sync Core (#689)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-08-12T22:50:35Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/26f3c3dbf523b52a729e8d5fb142b1c5b87ac649"
        },
        "date": 1786618507595,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 6.34,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 7.32,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 7.98,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 50.99,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 58.59,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 68.58,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 138.81,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 393.21,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 89.6,
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
          "id": "550d224520e488cec6f8c7f8cf4f0ba41d47979e",
          "message": "Release v5.2.2",
          "timestamp": "2026-08-14T02:24:23Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/550d224520e488cec6f8c7f8cf4f0ba41d47979e"
        },
        "date": 1786704903501,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 4.75,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 8.05,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 9.27,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 56.58,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 82.9,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 69.47,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 135.29,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 330.92,
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
          "id": "550d224520e488cec6f8c7f8cf4f0ba41d47979e",
          "message": "Release v5.2.2",
          "timestamp": "2026-08-14T02:24:23Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/550d224520e488cec6f8c7f8cf4f0ba41d47979e"
        },
        "date": 1786789856935,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.53,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 7.45,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 10.77,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 47.3,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 50.26,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 44.11,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 90.74,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 205,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 78.89,
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
          "id": "550d224520e488cec6f8c7f8cf4f0ba41d47979e",
          "message": "Release v5.2.2",
          "timestamp": "2026-08-14T02:24:23Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/550d224520e488cec6f8c7f8cf4f0ba41d47979e"
        },
        "date": 1786876564256,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.92,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.64,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 17.91,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 50.38,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 70.72,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 45.01,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 116.9,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 70.73,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 323.08,
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
          "id": "540b353f55a1869347e37a02c01c98e951a7a17c",
          "message": "feat: Sync Core (#705)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-08-17T02:18:56Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/540b353f55a1869347e37a02c01c98e951a7a17c"
        },
        "date": 1786963127958,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 4.82,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 8.71,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 12.76,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 45.98,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 52.04,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 45.7,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 91.95,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 224.74,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 85.03,
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
          "id": "0e27cb2ae0f8f6e554459ef872e9bd0fb09d2fe9",
          "message": "Add companion-check workflow: coordinated PRs auto-merge once their harper companion lands (#704)\n\n* ci: companion-check gate for PRs dependent on companion PRs (e.g. harper core)\n\nAdds a workflow posting a companion-check commit status driven by\nDepends-on: markers in PR bodies, so a coordinated harper-pro PR can be\napproved and armed for auto-merge, then merge automatically once its\nharper companion lands. Merging such a PR fires the existing sync_core\nrepository_dispatch so the core pointer is re-pointed at harper main\npromptly instead of at the nightly run.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* ci: harden companion-check per cross-model review\n\nFail closed on unparseable markers, support repo#N shorthand, bound and\ndedupe refs, isolate per-dep/per-PR errors, restrict the cross-repo\ntoken to same-org refs, guard sweep/event races, and skip no-marker PRs\nin the cron sweep.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* ci: fail closed on partial markers, heal statuses in sweep, harden sync\n\nRound-2 review fixes matching the documentation-repo copy, plus\nharper-pro-specific ones: split the closed-event concurrency group so an\nedit to a merged PR cannot cancel a pending sync_core dispatch, drop the\ndead case variant in the normalize-core condition, and make Sync Core\nreset core's branch tracking to main so a merged core:set-branch\noverride cannot wedge the nightly or dispatched sync. Adds the\nself-contained node test harness for the embedded script.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* ci: run companion-check tests in runLinter; hedge not-found diagnostic\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* ci: definitive 404s fail closed; align normalize grammar; guard sync reset to main\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* test: stateful script-block extraction and per-scenario fetch isolation (review feedback)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-08-18T02:44:53Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/0e27cb2ae0f8f6e554459ef872e9bd0fb09d2fe9"
        },
        "date": 1787049468679,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.4,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 7.64,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 9.26,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 63.99,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 73.6,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 46.58,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 94.97,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 95.72,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 378.17,
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
          "id": "23f3f46d5e252e63ed4116ff62f07b822ec72390",
          "message": "Release v5.2.3",
          "timestamp": "2026-08-19T02:09:53Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/23f3f46d5e252e63ed4116ff62f07b822ec72390"
        },
        "date": 1787135931094,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 9.7,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 11.25,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 15.45,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 57.49,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 65.56,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 52.56,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 103.19,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 265.34,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 109.69,
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
          "id": "84403ffb6bf2b9da23afc9ff120fa636e15f4a1f",
          "message": "fix(replication): fail loud on oversized frame, with backoff escalation and copy-batch capping (#713)",
          "timestamp": "2026-08-20T04:09:06Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/84403ffb6bf2b9da23afc9ff120fa636e15f4a1f"
        },
        "date": 1787222425757,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 10.15,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 16.53,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.28,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 24.4,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 25.57,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 26.73,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 50.37,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 134.01,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 272.02,
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
          "id": "bc55bf26a54a1e2cd7ba5204014f31e9551bad4a",
          "message": "Release v5.2.4",
          "timestamp": "2026-08-20T21:15:15Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/bc55bf26a54a1e2cd7ba5204014f31e9551bad4a"
        },
        "date": 1787308703193,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 7.84,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 12.9,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 15.27,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 47.34,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 53.76,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 50.9,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 102.04,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 109.01,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 233.58,
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
          "id": "d2a193fab1840bbe9b11c8e6a43c471d6b72406d",
          "message": "Stabilize copy-gap cursor banking regression coverage (#739)\n\n* Stabilize copy-gap cursor banking regression\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n* Update copy-gap workflow guard after suite rename\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n---------\n\nCo-authored-by: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-21T22:01:39Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/d2a193fab1840bbe9b11c8e6a43c471d6b72406d"
        },
        "date": 1787394822387,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.02,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 8.4,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 11.64,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 44.99,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 46.52,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 104.24,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 49.13,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 100.89,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 310.39,
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
          "id": "d2a193fab1840bbe9b11c8e6a43c471d6b72406d",
          "message": "Stabilize copy-gap cursor banking regression coverage (#739)\n\n* Stabilize copy-gap cursor banking regression\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n* Update copy-gap workflow guard after suite rename\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n---------\n\nCo-authored-by: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-21T22:01:39Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/d2a193fab1840bbe9b11c8e6a43c471d6b72406d"
        },
        "date": 1787481020674,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.32,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 7.38,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 9.43,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 48.11,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 60.59,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 48.47,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 101.32,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 204.79,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 78.88,
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
          "id": "d2a193fab1840bbe9b11c8e6a43c471d6b72406d",
          "message": "Stabilize copy-gap cursor banking regression coverage (#739)\n\n* Stabilize copy-gap cursor banking regression\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n* Update copy-gap workflow guard after suite rename\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n---------\n\nCo-authored-by: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-21T22:01:39Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/d2a193fab1840bbe9b11c8e6a43c471d6b72406d"
        },
        "date": 1787568017626,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 4.76,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 7.3,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 10.3,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 20.3,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 35.68,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 43.79,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 89.28,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 194.83,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 76.12,
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
          "id": "045370ca2fab6f2ae46874b3992ad7d81a3267f9",
          "message": "Release v5.2.5",
          "timestamp": "2026-08-25T05:23:38Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/045370ca2fab6f2ae46874b3992ad7d81a3267f9"
        },
        "date": 1787654297426,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.35,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 23.1,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 25.8,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.74,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 19.38,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 66.45,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 126.18,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 254.06,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 75,
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
          "id": "546ec7bcc37f58a56cc430966cdf59736d37f9bb",
          "message": "feat: Sync Core (#765)\n\nCo-authored-by: kriszyp <34054+kriszyp@users.noreply.github.com>",
          "timestamp": "2026-08-25T23:32:10Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/546ec7bcc37f58a56cc430966cdf59736d37f9bb"
        },
        "date": 1787741050311,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.41,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 9.08,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 11.32,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 50.52,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 60.06,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 71.31,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 130.41,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 257.84,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 118.67,
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
          "id": "fe108481ad21103b4b2dffbe41c357d9e204b656",
          "message": "Route dependency-manifest reviews to a single code owner (#758)\n\n* Route dependency-manifest reviews to a single code owner\n\nGitHub auto-requests @HarperFast/developers when a PR is opened, so a\ndependency bump lands in every team member's review queue for a lockfile\ndiff. Scope package.json and package-lock.json to one owner; the last\nmatching pattern wins, so everything else still routes to the team.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>\n\n* Anchor dependency CODEOWNERS patterns\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n---------\n\nCo-authored-by: Claude Opus 5 <noreply@anthropic.com>\nCo-authored-by: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-26T11:57:10Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/fe108481ad21103b4b2dffbe41c357d9e204b656"
        },
        "date": 1787839038279,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 4.91,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 8.23,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 9.35,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 51.42,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 61.02,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 47.36,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 94.33,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 88.37,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 203.51,
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
          "id": "d792a44a51ed09ca5b888065d709e4e846f040dd",
          "message": "ci: adopt ai-review-prompts fleet defaults and new review lenses (#766)\n\n* ci: adopt ai-review-prompts fleet defaults and new review lenses\n\nBump every ai-review-prompts pin to 4632c5d: claude-sonnet-5 model,\n--effort xhigh, 96-turn review budget (issue-to-pr 100), 30m timeouts\n(#89), the sibling-implementations and cannot-fail-test lenses (#88),\nand the week-of-08-10/08-17 calibration prompt edits (#85/#87).\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01S94XethbGXpAb4DRKMD4kt\n\n* ci: adopt ai-review-prompts #90 cost gates (pin be549ad) + ready_for_review trigger\n\nDraft PRs skip review until flipped ready (label still opts one in),\nmechanical diffs skip pre-run, reasoning effort scales with diff size\n(60/high, 1500/xhigh, else max), synchronize runs debounce 120s.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01S94XethbGXpAb4DRKMD4kt\n\n* ci: admit ready_for_review on label-opted PRs in opt-in mode\n\nkriszyp review finding on the pin-bump PR: with *_ALWAYS_ON unset, the\ncaller gate admitted only labeled events, so a PR opted in by label\nwhile draft never resumed review when flipped ready — the event died at\nthe caller gate. Admit ready_for_review when the opt-in label is still\npresent.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01S94XethbGXpAb4DRKMD4kt\n\n* ci: keep ineligible runs out of the review concurrency group\n\nkriszyp review finding: workflow-level cancel-in-progress fires before\njob if:, so in opt-in mode an ineligible event (a push, or a ready-flip\nwithout the opt-in label) cancels an in-flight label-triggered review\nand then skips — silently losing the requested review. Ineligible runs\nnow take a unique run_id group and can never cancel an eligible one;\neligible runs keep cancelling each other (the debounce contract).\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01S94XethbGXpAb4DRKMD4kt\n\n* ci: only the provider's own label makes a labeled run eligible\n\nReview finding (Codex + kriszyp, independently): the eligibility\npredicate admitted every labeled event, so in opt-in mode an unrelated\nlabel applied mid-review joined the eligible concurrency group,\ncancelled the running review, and the replacement then failed the\nreusable's exact-label gate — no completed review. The same\nunrelated-label cancellation existed in always-on mode before this\nseries (any labeled event shared the group and authorize then skipped).\n\nThe labeled branch now requires the provider's own label, in both the\nconcurrency predicate and the review job gate, and unrelated-label\nevents are ineligible in both modes.\n\nEvent matrix (opt-in / always-on):\n- labeled(provider label): eligible / eligible — supersedes in-flight\n- labeled(other): ineligible / ineligible (was: cancelled + no review)\n- synchronize: ineligible / eligible\n- ready_for_review + label: eligible / eligible\n- ready_for_review, no label: ineligible / eligible\n- opened, reopened: ineligible / eligible\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01S94XethbGXpAb4DRKMD4kt\n\n* ci: ready_for_review runs review but never cancels\n\nkriszyp follow-up finding: the label-opted ready_for_review event sat\nin the shared eligible concurrency group, so on a bot-authored PR it\ncould cancel the trusted labeler's in-flight review and then be\nrejected by author-based authorization — no completed review. The\ncancelling set (concurrency predicate) now excludes ready_for_review;\nthe running set (job gate) keeps it, so trusted-author ready-flips\nstill review, without the power to cancel. Revisit if the reusable\ngains persisted-label authorization.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01S94XethbGXpAb4DRKMD4kt\n\n* ci: exclude ready_for_review from the always-on cancelling arm\n\nCodex follow-up on the ready-noncancelling fix: ready_for_review is a\nnon-labeled event, so the ALWAYS_ON arm of the concurrency predicate\nstill placed it in the shared cancelling group in always-on mode — a\nlabel-opted bot PR's ready-flip could cancel the labeler's in-flight\nreview and then fail author-based authorization. The cancelling set now\nexcludes ready_for_review in BOTH modes; the job gates are unchanged\n(ready-flips run review, in their own run_id group).\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01S94XethbGXpAb4DRKMD4kt\n\n---------\n\nCo-authored-by: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-08-27T17:16:53Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/d792a44a51ed09ca5b888065d709e4e846f040dd"
        },
        "date": 1787916382748,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 6.25,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 13.4,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 16.04,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 46.92,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 53.76,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 45.9,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 90.6,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 200.17,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 69.6,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kyle Bernhardy",
            "username": "kylebernhardy",
            "email": "kyle@harperdb.io"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "cc5f7cf848bf34fe90bb9b1a0b2f33c0ac09b542",
          "message": "Prevent full-copy integration tests from leaking nodes (#778)\n\n* Always stop full-copy test nodes\n\n* Guard partial full-copy test starts",
          "timestamp": "2026-08-28T22:14:16Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/cc5f7cf848bf34fe90bb9b1a0b2f33c0ac09b542"
        },
        "date": 1787989693246,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.16,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 7.86,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 9.74,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.33,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 18.94,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 36.38,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 76.53,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 164.64,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 59.66,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kyle Bernhardy",
            "username": "kylebernhardy",
            "email": "kyle@harperdb.io"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "cc5f7cf848bf34fe90bb9b1a0b2f33c0ac09b542",
          "message": "Prevent full-copy integration tests from leaking nodes (#778)\n\n* Always stop full-copy test nodes\n\n* Guard partial full-copy test starts",
          "timestamp": "2026-08-28T22:14:16Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/cc5f7cf848bf34fe90bb9b1a0b2f33c0ac09b542"
        },
        "date": 1788076214258,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.15,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 11.22,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 13.41,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.99,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 23.33,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 46.5,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 94.83,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 145.25,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 61.96,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kyle Bernhardy",
            "username": "kylebernhardy",
            "email": "kyle@harperdb.io"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "cc5f7cf848bf34fe90bb9b1a0b2f33c0ac09b542",
          "message": "Prevent full-copy integration tests from leaking nodes (#778)\n\n* Always stop full-copy test nodes\n\n* Guard partial full-copy test starts",
          "timestamp": "2026-08-28T22:14:16Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/cc5f7cf848bf34fe90bb9b1a0b2f33c0ac09b542"
        },
        "date": 1788163163046,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.43,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 8.64,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 10.96,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.38,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 19.1,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 40.48,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 83.77,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 186.85,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 56.68,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "kriszyp",
            "username": "kriszyp",
            "email": "34054+kriszyp@users.noreply.github.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "b15fceb459203063dcc013a7de2f79e372d60cc9",
          "message": "feat: Sync Core",
          "timestamp": "2026-08-31T07:25:48Z",
          "url": "https://github.com/HarperFast/harper-pro/commit/b15fceb459203063dcc013a7de2f79e372d60cc9"
        },
        "date": 1788249307601,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 5.06,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 6.38,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 7.98,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 19.03,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 19.64,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 46.55,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 93.4,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 194.09,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 61.7,
            "unit": "ms"
          }
        ]
      }
    ]
  }
}