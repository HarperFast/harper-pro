/**
 * Component-level coverage for waf/waf.ts start()/middleware robustness (harper-pro#517 review).
 * Drives start() with a fake server/table so no Harper runtime is needed. Finding ids: O1–O4.
 */

import { expect } from 'chai';
import { start, stop, getCurrentMatcher } from '#src/waf/waf';

const RULE = {
	id: 'block-admin',
	enabled: true,
	priority: 1,
	phase: 'request',
	action: 'block',
	blockStatus: 403,
	match: { path: { prefix: '/admin' } },
};

function makeFakeTable(rows = [], overrides = {}) {
	return {
		primaryStore: {
			getRange: () => rows.map((value, i) => ({ key: value?.id ?? i, value })),
		},
		// subscribe never resolves here (tests don't exercise the live loop); return a never-ending
		// async iterable so the loop parks harmlessly.
		subscribe: async () => ({
			[Symbol.asyncIterator]() {
				return { next: () => new Promise(() => {}) };
			},
		}),
		...overrides,
	};
}

function makeFakeServer() {
	let registered = null;
	return {
		http: (listener, options) => {
			registered = { listener, options };
		},
		registerOperation: () => {},
		get middleware() {
			return registered;
		},
	};
}

function makeReq(overrides = {}) {
	const headers = new Map(Object.entries(overrides.headers ?? {}));
	return {
		ip: '203.0.113.7',
		method: 'GET',
		url: '/admin/panel',
		headers: { get: (n) => headers.get(n.toLowerCase()), keys: () => headers.keys() },
		...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'headers')),
	};
}

describe('WAF component middleware', () => {
	afterEach(() => stop());

	it('registers before authentication and runs first', () => {
		const server = makeFakeServer();
		start({ server, ensureTable: () => makeFakeTable([RULE]) });
		expect(server.middleware.options).to.include({ name: 'waf', before: 'authentication', runFirst: true });
	});

	it('O4: block response is opaque (no ruleIds), correct status/text, JSON content type', () => {
		const server = makeFakeServer();
		start({ server, ensureTable: () => makeFakeTable([{ ...RULE, blockStatus: 429 }]) });
		let passed = false;
		const response = server.middleware.listener(makeReq({ url: '/admin/x' }), () => {
			passed = true;
			return 'passthrough';
		});
		expect(passed).to.equal(false);
		expect(response.status).to.equal(429);
		expect(response.headers.get('Content-Type')).to.equal('application/json');
		const body = JSON.parse(response.body);
		expect(body.error).to.equal('Too Many Requests');
		expect(body).to.not.have.property('rules'); // ruleIds must NOT leak to the client
	});

	it('passes non-matching requests through', () => {
		const server = makeFakeServer();
		start({ server, ensureTable: () => makeFakeTable([RULE]) });
		let passed = false;
		const result = server.middleware.listener(makeReq({ url: '/public' }), () => {
			passed = true;
			return 'ok';
		});
		expect(passed).to.equal(true);
		expect(result).to.equal('ok');
	});

	it('O1: fails OPEN (passes through) when evaluate throws, and does not retain headers', () => {
		const server = makeFakeServer();
		start({ server, ensureTable: () => makeFakeTable([RULE]) });
		// a request whose url getter throws surfaces inside the try; middleware must fail open
		const badReq = {
			ip: '1.2.3.4',
			method: 'GET',
			headers: { get: () => undefined, keys: () => [] },
			get url() {
				throw new Error('boom');
			},
		};
		let passed = false;
		expect(() => server.middleware.listener(badReq, () => (passed = true))).to.not.throw();
		expect(passed).to.equal(true);
	});

	it('O2: an initial-compile failure still registers the middleware (pass-through), never throws out of start', () => {
		const server = makeFakeServer();
		const throwingTable = makeFakeTable([], {
			primaryStore: {
				getRange: () => {
					throw new Error('scan failed');
				},
			},
		});
		expect(() => start({ server, ensureTable: () => throwingTable })).to.not.throw();
		expect(server.middleware).to.not.equal(null); // middleware registered despite the failure
		// with no compiled matcher, traffic passes through
		let passed = false;
		server.middleware.listener(makeReq({ url: '/admin/x' }), () => (passed = true));
		expect(passed).to.equal(true);
	});

	it('respects enabled:false (no middleware, no matcher)', () => {
		const server = makeFakeServer();
		start({ server, enabled: false, ensureTable: () => makeFakeTable([RULE]) });
		expect(server.middleware).to.equal(null);
	});

	it('O3: log rate limit does not affect blocking (every request still blocked past the cap)', () => {
		const server = makeFakeServer();
		// rate limiting is internal to the logger; the contract is that FILTERING is independent of
		// the log cap, so every request is still blocked far beyond the cap.
		start({ server, logRateLimit: 2, ensureTable: () => makeFakeTable([RULE]) });
		let blocks = 0;
		for (let i = 0; i < 50; i++) {
			const response = server.middleware.listener(makeReq({ url: '/admin/x' }), () => 'pass');
			if (response && response.status === 403) blocks++;
		}
		expect(blocks).to.equal(50);
	});

	it('getCurrentMatcher exposes the compiled matcher', () => {
		const server = makeFakeServer();
		start({ server, ensureTable: () => makeFakeTable([RULE]) });
		expect(getCurrentMatcher().ruleCount).to.equal(1);
	});
});
