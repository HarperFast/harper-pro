window.BENCHMARK_DATA = {
  "lastUpdate": 1781697073123,
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
      }
    ]
  }
}