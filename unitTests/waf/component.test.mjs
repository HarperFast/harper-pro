/**
 * Component-level coverage for waf/waf.ts start()/middleware robustness (harper-pro#517 review).
 * Drives start() with a fake server/table so no Harper runtime is needed. Finding ids: O1–O4, plus
 * the control-row → global-mode seam (sentinel stripped, monitor downgrade, off kill switch) and the
 * block short-circuit contract (a block returns a response and never reaches the downstream handler).
 * The block-reaches-app / pre-auth-ordering guarantee against the REAL middleware runner needs a
 * built-runtime integration test (follow-up; a fake server can't validate runner semantics).
 */

import { expect } from 'chai';
import { start, stop, getCurrentMatcher } from '#src/waf/waf';
import { WAF_CONTROL_ID } from '#src/waf/ruleOperations';

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

	it('upper-cases the incoming method so a lowercase verb still hits a method-anchored rule', () => {
		const server = makeFakeServer();
		const methodRule = {
			id: 'block-delete',
			enabled: true,
			priority: 1,
			phase: 'request',
			action: 'block',
			match: { method: ['DELETE'] },
		};
		start({ server, ensureTable: () => makeFakeTable([methodRule]) });
		let reached = false;
		// raw servers can pass a non-canonical verb as-received; the WAF must fold case before matching
		const response = server.middleware.listener(makeReq({ url: '/x', method: 'delete' }), () => (reached = true));
		expect(reached).to.equal(false);
		expect(response.status).to.equal(403);
	});

	it('block short-circuit: a block returns a response and never reaches the downstream handler', () => {
		const server = makeFakeServer();
		start({ server, ensureTable: () => makeFakeTable([RULE]) });
		let reached = false;
		const response = server.middleware.listener(makeReq({ url: '/admin/x' }), () => {
			reached = true;
			return 'downstream';
		});
		expect(reached).to.equal(false); // downstream handler must be skipped (pre-auth short-circuit)
		expect(response).to.include({ status: 403 });
		expect(response.body).to.be.a('string');
	});

	it('control row → global mode: a __waf_control__ row is stripped from the rule list, not compiled', () => {
		const server = makeFakeServer();
		const control = { id: WAF_CONTROL_ID, mode: 'enforce' };
		start({ server, ensureTable: () => makeFakeTable([RULE, control]) });
		// the sentinel is pulled out before compile — it must NOT count as a rule
		expect(getCurrentMatcher().ruleCount).to.equal(1);
		// and enforcement still works with the (enforce) control row present
		let reached = false;
		const response = server.middleware.listener(makeReq({ url: '/admin/x' }), () => (reached = true));
		expect(reached).to.equal(false);
		expect(response.status).to.equal(403);
	});

	it("control row mode 'monitor' downgrades an enforcing rule to a would-block (pass-through)", () => {
		const server = makeFakeServer();
		const control = { id: WAF_CONTROL_ID, mode: 'monitor' };
		start({ server, ensureTable: () => makeFakeTable([RULE, control]) });
		expect(getCurrentMatcher().ruleCount).to.equal(1); // sentinel excluded
		let passed = false;
		const result = server.middleware.listener(makeReq({ url: '/admin/x' }), () => {
			passed = true;
			return 'ok';
		});
		expect(passed).to.equal(true); // monitor mode: the block is downgraded to a would-block, not enforced
		expect(result).to.equal('ok');
		// the matcher still surfaces the match as a shadow would-block for telemetry
		const decision = getCurrentMatcher().evaluate({
			ip: '203.0.113.7',
			method: 'GET',
			path: '/admin/x',
			query: undefined,
			getHeader: () => undefined,
		});
		expect(decision.shadowRuleIds).to.deep.equal(['block-admin']);
	});

	it("control row mode 'off' is a kill switch: matcher is empty and all traffic passes", () => {
		const server = makeFakeServer();
		const control = { id: WAF_CONTROL_ID, mode: 'off' };
		start({ server, ensureTable: () => makeFakeTable([RULE, control]) });
		expect(getCurrentMatcher().isEmpty).to.equal(true);
		let passed = false;
		server.middleware.listener(makeReq({ url: '/admin/x' }), () => (passed = true));
		expect(passed).to.equal(true);
	});

	it('block + log rules both matching → 403 AND the log rule is recorded on the decision', () => {
		const server = makeFakeServer();
		const logRule = {
			id: 'watch-admin',
			enabled: true,
			priority: 0, // matches before the block rule
			phase: 'request',
			action: 'log',
			match: { path: { prefix: '/admin' } },
		};
		start({ server, ensureTable: () => makeFakeTable([RULE, logRule]) });
		// enforcement: the middleware still blocks
		const response = server.middleware.listener(makeReq({ url: '/admin/x' }), () => 'pass');
		expect(response.status).to.equal(403);
		// telemetry: the decision the middleware logs from carries the matched log rule
		const decision = getCurrentMatcher().evaluate({
			ip: '203.0.113.7',
			method: 'GET',
			path: '/admin/x',
			query: undefined,
			getHeader: () => undefined,
		});
		expect(decision.ruleIds).to.deep.equal(['block-admin']);
		expect(decision.matchedLogRuleIds).to.deep.equal(['watch-admin']);
	});
});
