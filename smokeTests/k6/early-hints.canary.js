// early-hints smoke canary. Adapted from early-hints/tests/performance/performance.test.js.
// URLS is comma-separated (seeded pageUrls contain no commas).
import http from 'k6/http';
import { check } from 'k6';
import { b64encode } from 'k6/encoding';

const SCHEME = __ENV.SCHEME || 'http';
const HOST = __ENV.HOST;
const PORT = __ENV.PORT || '9926';
const USER = __ENV.USER || 'admin';
const PASSWORD = __ENV.PASSWORD || '';
const URLS = (__ENV.URLS || '').split(',').filter(Boolean);
const RATE = parseInt(__ENV.RATE || '20', 10);
const DURATION = __ENV.DURATION || '15s';
const DUR_P95 = parseInt(__ENV.DUR_P95 || '1000', 10);

const AUTH = 'Basic ' + b64encode(`${USER}:${PASSWORD}`);
const BASE = `${SCHEME}://${HOST}:${PORT}/hints`;

export const options = {
	insecureSkipTLSVerify: true,
	discardResponseBodies: true,
	scenarios: {
		hints: {
			executor: 'constant-arrival-rate',
			rate: RATE,
			timeUnit: '1s',
			duration: DURATION,
			preAllocatedVUs: Math.max(10, RATE * 2),
			maxVUs: Math.max(50, RATE * 10),
		},
	},
	thresholds: {
		http_req_failed: ['rate==0'],
		http_req_duration: [`p(95)<${DUR_P95}`],
	},
};

export default function () {
	if (URLS.length === 0) throw new Error('No URLS provided to early-hints canary');
	const pageUrl = URLS[Math.floor(Math.random() * URLS.length)];
	const url = `${BASE}?q=${encodeURIComponent(pageUrl)}`;
	const res = http.get(url, { headers: { Authorization: AUTH } });
	check(res, { 'status is 200': (r) => r.status === 200 });
}
