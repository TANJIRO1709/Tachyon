### Closed loop: throughput at fixed concurrency

| Concurrent clients | Mode | Throughput (req/s) | p50 ms | p95 ms | p99 ms | Mean batch | Model calls |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | unbatched | 11.6 | 84.8 | 109 | 127 | 1 | 93 |
| 1 | batched | 10.8 | 93.9 | 112 | 114 | 1 | 87 |
| 4 | unbatched | 11.9 | 332 | 382 | 395 | 1 | 99 |
| 4 | batched | 33.4 | 118 | 143 | 150 | 4 | 67 |
| 16 | unbatched | 12.3 | 1,319 | 1,372 | 1,389 | 1 | 114 |
| 16 | batched | 113.3 | 141 | 170 | 181 | 16 | 57 |
| 64 | unbatched | 11.9 | 5,263 | 5,447 | 5,488 | 1 | 158 |
| 64 | batched | 125.4 | 514 | 556 | 560 | 16 | 66 |

| Concurrent clients | Throughput gain | p50 change | p99 change |
| --- | --- | --- | --- |
| 1 | 0.94× | +11% | -10% |
| 4 | 2.81× | -64% | -62% |
| 16 | 9.24× | -89% | -87% |
| 64 | 10.52× | -90% | -90% |

### Open loop: latency at a fixed arrival rate

| Offered load (req/s) | Mode | Served (req/s) | p50 ms | p95 ms | p99 ms | Mean batch | Errors |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | unbatched | 10.4 | 535 | 892 | 923 | 1 | 0 |
| 10 | batched | 10.4 | 121 | 190 | 202 | 1.47 | 0 |
| 40 | unbatched | 12.1 | 9,474 | 18,129 | 18,894 | 1 | 0 |
| 40 | batched | 40.4 | 162 | 228 | 245 | 5.09 | 0 |
| 100 | unbatched | 11.9 | 30,163 | 57,129 | 59,399 | 1 | REQUEST_TIMEOUT 22 |
| 100 | batched | 102.8 | 208 | 289 | 320 | 15.15 | 0 |

_Measured 2026-10-12 16:48 UTC on linux x64, 2 CPUs, Node v22.22.0. Backend: stub, 80 ms base + 3 ms/item ± 15 ms, device concurrency 1. 8 s per run, unique input per request, cache disabled._
