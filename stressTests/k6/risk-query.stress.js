// risk-query stress. One constant-arrival-rate scenario per RATE level, chained via startTime,
// p95 threshold per scenario. Hits GET /risq/{id} against records seeded by the stress.mjs.
import http from 'k6/http';
import { check } from 'k6';
import { b64encode } from 'k6/encoding';

const SCHEME = __ENV.SCHEME || 'http';
const HOST = __ENV.HOST;
const PORT = __ENV.PORT || '9926';
const USER = __ENV.USER || 'admin';
const PASSWORD = __ENV.PASSWORD || '';
const RECORD_COUNT = parseInt(__ENV.RECORD_COUNT || '1000', 10);
const RATE_LEVELS = (__ENV.RATE_LEVELS || '50,100,300,500,900')
	.split(',')
	.map((n) => Number(n.trim()))
	.filter((n) => Number.isFinite(n) && n > 0);
const RATE_PLATEAU = __ENV.RATE_PLATEAU || '60s';
const RATE_PLATEAU_SEC = Number(__ENV.RATE_PLATEAU_SEC || 60);
const BUFFER_SEC = Number(__ENV.BUFFER_SEC || 10);
const TIME_UNIT = __ENV.TIME_UNIT || '1s';
const GRACEFUL_STOP = __ENV.GRACEFUL_STOP || '10s';
const DUR_P95 = Number(__ENV.DUR_P95 || 500);

// Little's Law: preallocated_VUs = target_RPS * (p95_ms/1000) * 1.5
const PREALLOC_VUS = Math.ceil(Math.max(...RATE_LEVELS) * (DUR_P95 / 1000) * 1.5);
const MAX_VUS = PREALLOC_VUS * 2;

const AUTH = 'Basic ' + b64encode(`${USER}:${PASSWORD}`);
const BASE = `${SCHEME}://${HOST}:${PORT}/risq/`;

const scenarios = Object.fromEntries(
	RATE_LEVELS.map((rate, i) => [
		`rps_${rate}`,
		{
			executor: 'constant-arrival-rate',
			rate,
			timeUnit: TIME_UNIT,
			duration: RATE_PLATEAU,
			startTime: `${i * (RATE_PLATEAU_SEC + BUFFER_SEC)}s`,
			preAllocatedVUs: PREALLOC_VUS,
			maxVUs: MAX_VUS,
			gracefulStop: GRACEFUL_STOP,
		},
	])
);

export const options = {
	insecureSkipTLSVerify: true,
	discardResponseBodies: true,
	systemTags: ['scenario'],
	scenarios,
	thresholds: Object.fromEntries(
		RATE_LEVELS.map((rate) => [`http_req_duration{scenario:rps_${rate}}`, [`p(95)<${DUR_P95}`]])
	),
};

export default function () {
	const id = Math.floor(Math.random() * RECORD_COUNT);
	const res = http.get(BASE + id, { headers: { Authorization: AUTH } });
	check(res, { 'status is 200': (r) => r.status === 200 });
}
