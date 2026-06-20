window.BENCHMARK_DATA = {
  "lastUpdate": 1781954359770,
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
            "name": "load",
            "value": 10001.61,
            "unit": "records/sec"
          },
          {
            "name": "workload C",
            "value": 22506.98,
            "unit": "ops/sec"
          },
          {
            "name": "workload B",
            "value": 8384.77,
            "unit": "ops/sec"
          },
          {
            "name": "workload A",
            "value": 9546.23,
            "unit": "ops/sec"
          },
          {
            "name": "workload F",
            "value": 4584.27,
            "unit": "ops/sec"
          },
          {
            "name": "workload E",
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
            "name": "load",
            "value": 1817.69,
            "unit": "records/sec"
          },
          {
            "name": "workload C",
            "value": 5914.16,
            "unit": "ops/sec"
          },
          {
            "name": "workload B",
            "value": 4964.76,
            "unit": "ops/sec"
          },
          {
            "name": "workload A",
            "value": 3500.79,
            "unit": "ops/sec"
          },
          {
            "name": "workload F",
            "value": 1903.74,
            "unit": "ops/sec"
          },
          {
            "name": "workload E",
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
            "name": "load",
            "value": 1740.76,
            "unit": "records/sec"
          },
          {
            "name": "workload C",
            "value": 21349.12,
            "unit": "ops/sec"
          },
          {
            "name": "workload B",
            "value": 3756.52,
            "unit": "ops/sec"
          },
          {
            "name": "workload A",
            "value": 3604.52,
            "unit": "ops/sec"
          },
          {
            "name": "workload F",
            "value": 2400.38,
            "unit": "ops/sec"
          },
          {
            "name": "workload E",
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
            "name": "load",
            "value": 11040.41,
            "unit": "records/sec"
          },
          {
            "name": "workload C",
            "value": 22512.59,
            "unit": "ops/sec"
          },
          {
            "name": "workload B",
            "value": 21524.37,
            "unit": "ops/sec"
          },
          {
            "name": "workload A",
            "value": 4368.58,
            "unit": "ops/sec"
          },
          {
            "name": "workload F",
            "value": 4464.64,
            "unit": "ops/sec"
          },
          {
            "name": "workload E",
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
            "name": "load",
            "value": 9836.19,
            "unit": "records/sec"
          },
          {
            "name": "workload C",
            "value": 23703.73,
            "unit": "ops/sec"
          },
          {
            "name": "workload B",
            "value": 6036.49,
            "unit": "ops/sec"
          },
          {
            "name": "workload A",
            "value": 8708.69,
            "unit": "ops/sec"
          },
          {
            "name": "workload F",
            "value": 2816.88,
            "unit": "ops/sec"
          },
          {
            "name": "workload E",
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
        "date": 1781830601887,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load",
            "value": 7328.85,
            "unit": "records/sec"
          },
          {
            "name": "workload C",
            "value": 2196.51,
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
        "date": 1781846495381,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load",
            "value": 7742.82,
            "unit": "records/sec"
          },
          {
            "name": "workload C",
            "value": 25764.1,
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
            "name": "load",
            "value": 10192.49,
            "unit": "records/sec"
          },
          {
            "name": "workload C",
            "value": 25347.88,
            "unit": "ops/sec"
          },
          {
            "name": "workload B",
            "value": 21788.42,
            "unit": "ops/sec"
          },
          {
            "name": "workload A",
            "value": 5692.56,
            "unit": "ops/sec"
          },
          {
            "name": "workload F",
            "value": 5588.09,
            "unit": "ops/sec"
          },
          {
            "name": "workload E",
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
            "name": "C read p99",
            "value": 7.17,
            "unit": "ms"
          },
          {
            "name": "B read p99",
            "value": 62.19,
            "unit": "ms"
          },
          {
            "name": "B update p99",
            "value": 70.41,
            "unit": "ms"
          },
          {
            "name": "A read p99",
            "value": 19.9,
            "unit": "ms"
          },
          {
            "name": "A update p99",
            "value": 21.35,
            "unit": "ms"
          },
          {
            "name": "F read p99",
            "value": 71.51,
            "unit": "ms"
          },
          {
            "name": "F rmw p99",
            "value": 147.26,
            "unit": "ms"
          },
          {
            "name": "E scan p99",
            "value": 247.39,
            "unit": "ms"
          },
          {
            "name": "E insert p99",
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
            "name": "C read p99",
            "value": 92.72,
            "unit": "ms"
          },
          {
            "name": "B read p99",
            "value": 90.27,
            "unit": "ms"
          },
          {
            "name": "B update p99",
            "value": 102.88,
            "unit": "ms"
          },
          {
            "name": "A read p99",
            "value": 126.83,
            "unit": "ms"
          },
          {
            "name": "A update p99",
            "value": 138.44,
            "unit": "ms"
          },
          {
            "name": "F read p99",
            "value": 160.98,
            "unit": "ms"
          },
          {
            "name": "F rmw p99",
            "value": 313.81,
            "unit": "ms"
          },
          {
            "name": "E insert p99",
            "value": 371.94,
            "unit": "ms"
          },
          {
            "name": "E scan p99",
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
            "name": "C read p99",
            "value": 7.15,
            "unit": "ms"
          },
          {
            "name": "B read p99",
            "value": 102.84,
            "unit": "ms"
          },
          {
            "name": "B update p99",
            "value": 113.17,
            "unit": "ms"
          },
          {
            "name": "A read p99",
            "value": 126.56,
            "unit": "ms"
          },
          {
            "name": "A update p99",
            "value": 139.67,
            "unit": "ms"
          },
          {
            "name": "F read p99",
            "value": 126.5,
            "unit": "ms"
          },
          {
            "name": "F rmw p99",
            "value": 242.9,
            "unit": "ms"
          },
          {
            "name": "E insert p99",
            "value": 310.13,
            "unit": "ms"
          },
          {
            "name": "E scan p99",
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
            "name": "C read p99",
            "value": 6.98,
            "unit": "ms"
          },
          {
            "name": "B read p99",
            "value": 7.95,
            "unit": "ms"
          },
          {
            "name": "B update p99",
            "value": 11.55,
            "unit": "ms"
          },
          {
            "name": "A read p99",
            "value": 90.27,
            "unit": "ms"
          },
          {
            "name": "A update p99",
            "value": 112.01,
            "unit": "ms"
          },
          {
            "name": "F read p99",
            "value": 67.92,
            "unit": "ms"
          },
          {
            "name": "F rmw p99",
            "value": 144.79,
            "unit": "ms"
          },
          {
            "name": "E scan p99",
            "value": 385.11,
            "unit": "ms"
          },
          {
            "name": "E insert p99",
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
            "name": "C read p99",
            "value": 6.53,
            "unit": "ms"
          },
          {
            "name": "B read p99",
            "value": 59.27,
            "unit": "ms"
          },
          {
            "name": "B update p99",
            "value": 68.43,
            "unit": "ms"
          },
          {
            "name": "A read p99",
            "value": 30.35,
            "unit": "ms"
          },
          {
            "name": "A update p99",
            "value": 32.29,
            "unit": "ms"
          },
          {
            "name": "F read p99",
            "value": 96.68,
            "unit": "ms"
          },
          {
            "name": "F rmw p99",
            "value": 179.55,
            "unit": "ms"
          },
          {
            "name": "E insert p99",
            "value": 151.3,
            "unit": "ms"
          },
          {
            "name": "E scan p99",
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
        "date": 1781830606999,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99",
            "value": 50.89,
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
        "date": 1781846498365,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99",
            "value": 2.91,
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
            "name": "C read p99",
            "value": 6.31,
            "unit": "ms"
          },
          {
            "name": "B read p99",
            "value": 7.06,
            "unit": "ms"
          },
          {
            "name": "B update p99",
            "value": 9.02,
            "unit": "ms"
          },
          {
            "name": "A read p99",
            "value": 72.38,
            "unit": "ms"
          },
          {
            "name": "A update p99",
            "value": 80.92,
            "unit": "ms"
          },
          {
            "name": "F read p99",
            "value": 59.66,
            "unit": "ms"
          },
          {
            "name": "F rmw p99",
            "value": 122.65,
            "unit": "ms"
          },
          {
            "name": "E scan p99",
            "value": 258.25,
            "unit": "ms"
          },
          {
            "name": "E insert p99",
            "value": 103.7,
            "unit": "ms"
          }
        ]
      }
    ]
  }
}