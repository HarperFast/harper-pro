/**
 * Micro-benchmark for the compiled WAF matcher (waf/matcher.ts).
 *
 * Measures matcher.evaluate() directly with node:perf_hooks over mixed synthetic rule sets of
 * 10 / 100 / 1000 rules, for (a) a typical non-matching request (the 99% path) and (b) several
 * matching requests. The request object mirrors the middleware adapter shape (ip, method, path,
 * query, getHeader over ~12 headers).
 *
 * Run: node benchmarks/waf/matcher-bench.mjs   (loads dist via #src; build first)
 */

import { performance } from 'node:perf_hooks';
import { compileRules } from '#src/waf/matcher';

// Deterministic LCG so rule sets are reproducible across runs
function makeRandom(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

const ACTIONS = ['block', 'block', 'log', 'score']; // score rules get score: 4
const HEADER_RULES = [
	{ name: 'User-Agent', op: 'contains', value: 'sqlmap' },
	{ name: 'User-Agent', op: 'contains', value: 'nikto' },
	{ name: 'X-Scanner', op: 'exists' },
	{ name: 'Authorization', op: 'prefix', value: 'Negotiate' },
	{ name: 'X-Api-Version', op: 'regex', value: '^v[0-9]+\\.[0-9]+$' },
];

function generateRules(count, random) {
	const rules = [];
	for (let i = 0; i < count; i++) {
		const kind = random();
		const action = ACTIONS[(random() * ACTIONS.length) | 0];
		const base = {
			id: `rule-${i}`,
			enabled: true,
			priority: (random() * 100) | 0,
			phase: 'request',
			action,
			score: action === 'score' ? 4 : undefined,
		};
		if (kind < 0.3) {
			// ip CIDRs in 198.18.0.0/15 (benchmarking range), distinct /24s
			const octet2 = 18 + (i % 2);
			const octet3 = (i * 7) % 256;
			rules.push({ ...base, match: { ip: `198.${octet2}.${octet3}.0/24` } });
		} else if (kind < 0.4) {
			rules.push({ ...base, match: { path: { exact: `/blocked/resource-${i}` } } });
		} else if (kind < 0.65) {
			rules.push({ ...base, match: { path: { prefix: `/blocked/prefix-${i}/` } } });
		} else if (kind < 0.75) {
			rules.push({ ...base, match: { path: { regex: `^/legacy-${i}/.*\\.(php|cgi)$` } } });
		} else if (kind < 0.9) {
			rules.push({ ...base, match: { headers: [HEADER_RULES[i % HEADER_RULES.length]] } });
		} else if (kind < 0.95) {
			rules.push({ ...base, match: { query: [{ name: `attack-${i}`, op: 'contains', value: ';' }] } });
		} else {
			rules.push({ ...base, match: { method: ['DELETE'], path: { prefix: `/api-admin-${i}/` } } });
		}
	}
	return rules;
}

// ~12 realistic headers
function makeHeaders(overrides = {}) {
	return new Map(
		Object.entries({
			'host': 'api.example.com',
			'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
			'accept': 'application/json, text/plain, */*',
			'accept-encoding': 'gzip, deflate, br, zstd',
			'accept-language': 'en-US,en;q=0.9',
			'authorization': 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.abcdefghijklmnopqrstuvwxyz012345',
			'content-type': 'application/json',
			'origin': 'https://app.example.com',
			'referer': 'https://app.example.com/dashboard',
			'x-request-id': '3f9a2b1c-7d44-4e21-9c8a-2f6f0a9b1e77',
			'connection': 'keep-alive',
			'cache-control': 'no-cache',
			...overrides,
		})
	);
}

function makeRequest(overrides = {}, headerOverrides = {}) {
	const headers = makeHeaders(headerOverrides);
	return {
		ip: '203.0.113.77',
		method: 'GET',
		path: '/api/products/12345',
		query: undefined,
		getHeader: (name) => headers.get(name.toLowerCase()),
		headerNames: () => headers.keys(),
		...overrides,
	};
}

let sink = 0; // defeats dead-code elimination

function bench(label, matcher, request, { warmup = 50_000, batch = 200_000, samples = 7 } = {}) {
	for (let i = 0; i < warmup; i++) {
		if (matcher.evaluate(request) !== null) sink++;
	}
	const timings = [];
	for (let s = 0; s < samples; s++) {
		const start = performance.now();
		for (let i = 0; i < batch; i++) {
			if (matcher.evaluate(request) !== null) sink++;
		}
		const elapsed = performance.now() - start;
		timings.push((elapsed * 1e6) / batch); // ns/op
	}
	timings.sort((a, b) => a - b);
	const best = timings[0];
	const median = timings[(timings.length / 2) | 0];
	return { label, best, median };
}

function formatRow(cells, widths) {
	return cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ');
}

const RULE_COUNTS = [10, 100, 1000];
const results = [];

for (const count of RULE_COUNTS) {
	const random = makeRandom(42);
	const rules = generateRules(count, random);
	const compileStart = performance.now();
	const matcher = compileRules(rules, { scoreThreshold: 10 });
	const compileMs = performance.now() - compileStart;
	if (matcher.invalidRules.size > 0) {
		console.error(`unexpected invalid rules at count ${count}:`, matcher.invalidRules);
		process.exit(1);
	}

	// (a) the 99% path: typical request matching nothing
	results.push({ count, compileMs, ...bench('non-matching (typical)', matcher, makeRequest()) });
	// non-matching with a query string present (exercises the query-anchor guard)
	results.push({
		count,
		compileMs,
		...bench('non-matching + query string', matcher, makeRequest({ query: 'page=2&size=50' })),
	});
	// (b) matching requests
	const ipRule = rules.find((rule) => rule.match.ip);
	if (ipRule) {
		const cidr = Array.isArray(ipRule.match.ip) ? ipRule.match.ip[0] : ipRule.match.ip;
		const ip = cidr.replace(/\.0\/24$/, '.99');
		results.push({ count, compileMs, ...bench('matching: ip CIDR', matcher, makeRequest({ ip })) });
	}
	const prefixRule = rules.find((rule) => rule.match.path?.prefix && !rule.match.method);
	if (prefixRule) {
		const path = `${prefixRule.match.path.prefix}download`;
		results.push({ count, compileMs, ...bench('matching: path prefix', matcher, makeRequest({ path })) });
	}
	const headerRule = rules.find((rule) => rule.match.headers?.[0]?.op === 'contains');
	if (headerRule) {
		const { name, value } = headerRule.match.headers[0];
		results.push({
			count,
			compileMs,
			...bench('matching: header contains', matcher, makeRequest({}, { [name.toLowerCase()]: `${value}/1.7` })),
		});
	}
}

const widths = [6, 30, 12, 12, 14];
console.log(
	`node ${process.version}, ${process.arch}, rules mixed ~30% ip / 45% path / 15% header / 5% query / 5% method+path`
);
console.log(formatRow(['rules', 'scenario', 'best ns/op', 'med ns/op', 'compile ms'], widths));
let lastCount = -1;
for (const result of results) {
	console.log(
		formatRow(
			[
				result.count === lastCount ? '' : result.count,
				result.label,
				result.best.toFixed(1),
				result.median.toFixed(1),
				result.count === lastCount ? '' : result.compileMs.toFixed(2),
			],
			widths
		)
	);
	lastCount = result.count;
}
console.log(`(sink=${sink})`);
