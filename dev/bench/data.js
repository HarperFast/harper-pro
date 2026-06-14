window.BENCHMARK_DATA = {
  "lastUpdate": 1781435624080,
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
      }
    ]
  }
}