// redirector smoke canary. Adapted from redirector/tests/performance/performance.test.js.
// Sends v=0 explicitly to avoid the getCurrentVersion() hang on an empty Version table (v5 report).
import http from 'k6/http';
import { check } from 'k6';
import { b64encode } from 'k6/encoding';

const SCHEME = __ENV.SCHEME || 'http';
const HOST = __ENV.HOST;
const PORT = __ENV.PORT || '9926';
const USER = __ENV.USER || 'admin';
const PASSWORD = __ENV.PASSWORD || '';
const PATHS = (__ENV.PATHS || '').split(',').filter(Boolean);
const RATE = parseInt(__ENV.RATE || '20', 10);
const DURATION = __ENV.DURATION || '15s';
const DUR_P95 = parseInt(__ENV.DUR_P95 || '1000', 10);

const AUTH = 'Basic ' + b64encode(`${USER}:${PASSWORD}`);
const BASE = `${SCHEME}://${HOST}:${PORT}/checkredirect`;

export const options = {
	insecureSkipTLSVerify: true,
	discardResponseBodies: true,
	scenarios: {
		checkredirect: {
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
	if (PATHS.length === 0) throw new Error('No PATHS provided to redirector canary');
	const path = PATHS[Math.floor(Math.random() * PATHS.length)];
	const url = `${BASE}?v=0&path=${encodeURIComponent(path)}`;
	const res = http.get(url, { headers: { Authorization: AUTH } });
	check(res, { 'status is 2xx': (r) => r.status >= 200 && r.status < 300 });
}
