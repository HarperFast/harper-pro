// risk-query smoke canary. Adapted from risk-query/test/performance/perf_kv_lookup_get.js.
// Reads pre-seeded records at a low fixed rate. Pass/fail on 0 failures + generous p95.
import http from 'k6/http';
import { check } from 'k6';
import { b64encode } from 'k6/encoding';

const SCHEME = __ENV.SCHEME || 'http';
const HOST = __ENV.HOST;
const PORT = __ENV.PORT || '9926';
const USER = __ENV.USER || 'admin';
const PASSWORD = __ENV.PASSWORD || '';
const RECORD_COUNT = parseInt(__ENV.RECORD_COUNT || '100', 10);
const RATE = parseInt(__ENV.RATE || '10', 10);
const DURATION = __ENV.DURATION || '15s';
const DUR_P95 = parseInt(__ENV.DUR_P95 || '1000', 10);

const AUTH = 'Basic ' + b64encode(`${USER}:${PASSWORD}`);
const BASE = `${SCHEME}://${HOST}:${PORT}/risq/`;

export const options = {
	insecureSkipTLSVerify: true,
	discardResponseBodies: true,
	scenarios: {
		get: {
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
	const id = Math.floor(Math.random() * RECORD_COUNT);
	const res = http.get(BASE + id, { headers: { Authorization: AUTH } });
	check(res, { 'status is 200': (r) => r.status === 200 });
}
