/**
 * End-to-end WAF latency smoke: measures request latency on the app HTTP port against a
 * running local instance (see the boot recipe in the PR/branch notes). Sequential requests,
 * warmup discarded, reports mean/p50/p99 in microseconds.
 *
 * Usage: node benchmarks/waf/e2e-latency.mjs [label] [url] [count]
 */

const label = process.argv[2] ?? 'run';
const url = process.argv[3] ?? 'http://127.0.0.1:19926/api/products/12345';
const count = Number(process.argv[4] ?? 3000);
const warmup = Math.min(500, count >> 2);

const timings = [];
for (let i = 0; i < count + warmup; i++) {
	const start = process.hrtime.bigint();
	const response = await fetch(url);
	await response.arrayBuffer();
	const elapsed = Number(process.hrtime.bigint() - start) / 1000; // µs
	if (i >= warmup) timings.push(elapsed);
}
timings.sort((a, b) => a - b);
const mean = timings.reduce((sum, value) => sum + value, 0) / timings.length;
const p = (q) => timings[Math.min(timings.length - 1, (timings.length * q) | 0)];
console.log(
	`${label}: n=${timings.length} mean=${mean.toFixed(1)}µs p50=${p(0.5).toFixed(1)}µs p90=${p(0.9).toFixed(1)}µs p99=${p(0.99).toFixed(1)}µs`
);
