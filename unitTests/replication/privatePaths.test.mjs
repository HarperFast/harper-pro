/** Coverage for choosing a peer's private replication address and recovering it (harper-pro#1292). */

import assert from 'node:assert';
import tls from 'node:tls';
import * as env from '#src/core/utility/environment/environmentManager';
import {
	PrivatePaths,
	localNetworks,
	normalizePrivateUrls,
	privateUrlOn,
	publicTlsIdentity,
	samePrivateUrls,
} from '#src/replication/privatePaths';
import { PATH_PRIVATE, PATH_PUBLIC, PATH_PUBLIC_FALLBACK } from '#src/replication/sharedStatusSlots';

const PUBLIC = 'wss://node-b.example.com:9933';
const PRIVATE = 'wss://10.0.0.2:9933';

describe('privatePaths', () => {
	describe('reading private URLs', () => {
		it('keeps only wss URLs with a host, no credentials, query or fragment, and a network', () => {
			assert.deepStrictEqual(
				normalizePrivateUrls([
					{ url: PRIVATE, network: 'net1', extra: true },
					null,
					'wss://10.0.0.3:9933',
					{ url: 'ws://10.0.0.4:9933', network: 'net1' },
					{ url: 'wss://user:pw@10.0.0.5:9933', network: 'net1' },
					{ url: 'wss://10.0.0.5:9933/?token=x', network: 'net1' },
					{ url: 'wss://10.0.0.5:9933/#x', network: 'net1' },
					{ url: 'not a url', network: 'net1' },
					{ url: 'wss://10.0.0.6:9933', network: '' },
					{ url: 42, network: 'net1' },
					{ url: 'wss://[fd00::7]:9933', network: 'net2' },
				]),
				[
					{ url: PRIVATE, network: 'net1' },
					{ url: 'wss://[fd00::7]:9933', network: 'net2' },
				]
			);
			for (const value of [undefined, null, 'wss://10.0.0.2:9933', { url: PRIVATE }, [], [null]])
				assert.strictEqual(normalizePrivateUrls(value), undefined, JSON.stringify(value));
		});

		it("picks the first of the peer's URLs on one of this node's networks", () => {
			const peer = {
				private_urls: [
					{ url: 'ws://10.0.0.9:9933', network: 'net1' },
					{ url: 'wss://10.1.0.2:9933', network: 'net2' },
					{ url: PRIVATE, network: 'net1' },
				],
			};
			assert.strictEqual(privateUrlOn(peer, new Set(['net1'])), PRIVATE);
			assert.strictEqual(privateUrlOn(peer, new Set(['net1', 'net2'])), 'wss://10.1.0.2:9933');
			assert.strictEqual(privateUrlOn(peer, new Set(['net3'])), undefined);
			assert.strictEqual(privateUrlOn(peer, new Set()), undefined);
			assert.strictEqual(privateUrlOn({ private_urls: 'x' }, new Set(['net1'])), undefined);
			assert.strictEqual(privateUrlOn(undefined, new Set(['net1'])), undefined);
		});

		it('compares advertisements by their usable entries, treating none and null alike', () => {
			const a = [{ url: PRIVATE, network: 'net1' }];
			assert.ok(samePrivateUrls(a, [{ url: PRIVATE, network: 'net1', extra: 1 }]));
			assert.ok(samePrivateUrls(undefined, null));
			assert.ok(samePrivateUrls(undefined, []));
			assert.ok(!samePrivateUrls(a, undefined));
			assert.ok(!samePrivateUrls(a, [{ url: PRIVATE, network: 'net2' }]));
		});

		it('dials from replication.network and from every network this node is reachable on', () => {
			const saved = [env.get('replication_network'), env.get('replication_privateUrls')];
			try {
				env.setProperty('replication_network', 'net1');
				env.setProperty('replication_privateUrls', [
					{ url: PRIVATE, network: 'net2' },
					{ url: 'wss://10.9.0.2:9933', network: 'net3' },
				]);
				assert.deepStrictEqual([...localNetworks()].sort(), ['net1', 'net2', 'net3']);
				env.setProperty('replication_network', undefined);
				env.setProperty('replication_privateUrls', undefined);
				assert.strictEqual(localNetworks().size, 0);
			} finally {
				env.setProperty('replication_network', saved[0]);
				env.setProperty('replication_privateUrls', saved[1]);
			}
		});
	});

	describe('TLS identity of the public URL', () => {
		it('presents and checks the name the public dial uses, for each node-name and URL shape', () => {
			// a hostname node name is the SNI and the certificate name, whatever the URL says
			assert.deepStrictEqual(publicTlsIdentity('wss://203.0.113.10:9933', 'node-b.example.com'), {
				servername: 'node-b.example.com',
				checkHost: 'node-b.example.com',
			});
			// an IP node name: ws derives SNI from a DNS URL host
			assert.deepStrictEqual(publicTlsIdentity(PUBLIC, '203.0.113.10'), {
				servername: 'node-b.example.com',
				checkHost: 'node-b.example.com',
			});
			// IP node name and IP URL: no SNI, certificate checked against the URL's IP (without its port)
			assert.deepStrictEqual(publicTlsIdentity('wss://203.0.113.10:9933', '203.0.113.10'), {
				servername: '',
				checkHost: '203.0.113.10',
			});
			assert.deepStrictEqual(publicTlsIdentity('wss://[2001:db8::1]:9933', '2001:db8::1'), {
				servername: '',
				checkHost: '2001:db8::1',
			});
		});

		it("accepts the peer's certificate at a private address only for the public name", () => {
			const named = { subject: { CN: 'node-b.example.com' }, subjectaltname: 'DNS:node-b.example.com' };
			const byIp = { subject: { CN: '203.0.113.10' }, subjectaltname: 'IP Address:203.0.113.10' };
			// what node:tls checks by default for a dial to the private IP, and why the override is needed
			assert.ok(tls.checkServerIdentity('10.0.0.2', named) instanceof Error);
			assert.strictEqual(
				tls.checkServerIdentity(publicTlsIdentity(PUBLIC, 'node-b.example.com').checkHost, named),
				undefined
			);
			assert.strictEqual(
				tls.checkServerIdentity(publicTlsIdentity('wss://203.0.113.10:9933', '203.0.113.10').checkHost, byIp),
				undefined
			);
			// another node's certificate fails
			assert.ok(
				tls.checkServerIdentity(publicTlsIdentity(PUBLIC, 'node-c.example.com').checkHost, named) instanceof Error
			);
		});
	});

	describe('PrivatePaths', () => {
		// timers run only when the test says so
		function harness() {
			const timers = [];
			const paths = new PrivatePaths({
				setTimer: (callback, delay) => {
					const timer = { callback, delay, cleared: false, unref() {} };
					timers.push(timer);
					return timer;
				},
				clearTimer: (timer) => {
					if (timer) timer.cleared = true;
				},
				random: () => 0.5,
			});
			const pending = () => timers.filter((timer) => !timer.cleared && !timer.fired);
			// runs the timer, then lets the probe it may start settle
			const fire = async (timer) => {
				timer.fired = true;
				timer.callback();
				await new Promise((resolve) => setImmediate(resolve));
			};
			return { paths, timers, pending, fire };
		}

		function waiter(name, { reachable = true, promotable = true } = {}) {
			return {
				name,
				probes: 0,
				promotions: 0,
				reachable,
				promotable,
				async probePrivatePath() {
					this.probes++;
					return this.reachable;
				},
				promoteToPrivatePath() {
					if (!this.promotable) return false;
					this.promotions++;
					return true;
				},
			};
		}

		it('dials the private URL until it fails, then the public one', () => {
			const { paths } = harness();
			const a = waiter('a');
			assert.deepStrictEqual(paths.choose(PUBLIC, undefined, a), { url: PUBLIC, path: PATH_PUBLIC });
			assert.deepStrictEqual(paths.choose(PUBLIC, PRIVATE, a), {
				url: PRIVATE,
				path: PATH_PRIVATE,
				privateUrl: PRIVATE,
			});
			assert.strictEqual(paths.failed(PRIVATE, a), true, 'the first failure starts the outage');
			assert.strictEqual(paths.failed(PRIVATE, waiter('b')), false, 'later failures do not restart it');
			assert.deepStrictEqual(paths.choose(PUBLIC, PRIVATE, a), {
				url: PUBLIC,
				path: PATH_PUBLIC_FALLBACK,
				privateUrl: PRIVATE,
			});
		});

		it('probes on a backoff, and a failed probe waits longer', async () => {
			const { paths, pending, fire } = harness();
			const a = waiter('a', { reachable: false });
			paths.failed(PRIVATE, a);
			assert.strictEqual(pending().length, 1, 'one probe per URL');
			const first = pending()[0];
			assert.strictEqual(first.delay, 3000); // floor 1 s + half of the 4 s window
			await fire(first);
			assert.strictEqual(a.probes, 1);
			assert.strictEqual(a.promotions, 0);
			const second = pending()[0];
			assert.strictEqual(second.delay, 5500, 'the ceiling doubles');
		});

		it('a successful probe promotes one canary; only the canary dials privately', async () => {
			const { paths, pending, fire } = harness();
			const a = waiter('a');
			const b = waiter('b');
			paths.failed(PRIVATE, a);
			paths.failed(PRIVATE, b);
			await fire(pending()[0]);
			assert.strictEqual(a.promotions + b.promotions, 1, 'exactly one connection is promoted');
			const canary = a.promotions ? a : b;
			const other = canary === a ? b : a;
			assert.strictEqual(paths.choose(PUBLIC, PRIVATE, canary).path, PATH_PRIVATE);
			assert.strictEqual(paths.choose(PUBLIC, PRIVATE, other).path, PATH_PUBLIC_FALLBACK);
		});

		it("the canary's identified peer ends the outage and promotes the rest, staggered", async () => {
			const { paths, pending, fire } = harness();
			const [a, b, c] = [waiter('a'), waiter('b'), waiter('c')];
			for (const w of [a, b, c]) paths.failed(PRIVATE, w);
			await fire(pending()[0]);
			const canary = [a, b, c].find((w) => w.promotions === 1);
			assert.strictEqual(paths.identified(PRIVATE), true);
			assert.strictEqual(paths.identified(PRIVATE), false, 'no outage left to end');
			const promotions = pending();
			assert.deepStrictEqual(
				promotions.map((timer) => timer.delay),
				[0, 50]
			);
			for (const timer of promotions) await fire(timer);
			for (const w of [a, b, c]) assert.strictEqual(w.promotions, 1, `${w.name} promoted once`);
			assert.strictEqual(paths.choose(PUBLIC, PRIVATE, a).path, PATH_PRIVATE);
			assert.ok(canary);
		});

		it("a connection sent to the fallback by another connection's failure is promoted too", async () => {
			const { paths, pending, fire } = harness();
			const failing = waiter('failing');
			const bystander = waiter('bystander');
			paths.failed(PRIVATE, failing);
			assert.strictEqual(paths.choose(PUBLIC, PRIVATE, bystander).path, PATH_PUBLIC_FALLBACK);
			await fire(pending()[0]);
			const canary = failing.promotions ? failing : bystander;
			paths.identified(PRIVATE);
			for (const timer of pending()) await fire(timer);
			assert.strictEqual(failing.promotions + bystander.promotions, 2, 'both connections redial privately');
			assert.ok(canary);
		});

		it('a failed canary puts the URL back down and keeps backing off', async () => {
			const { paths, pending, fire } = harness();
			const a = waiter('a');
			paths.failed(PRIVATE, a);
			const firstDelay = pending()[0].delay;
			await fire(pending()[0]);
			assert.strictEqual(a.promotions, 1);
			paths.failed(PRIVATE, a);
			assert.strictEqual(paths.choose(PUBLIC, PRIVATE, a).path, PATH_PUBLIC_FALLBACK);
			const next = pending();
			assert.strictEqual(next.length, 1, 'the canary timeout is cleared and one probe is scheduled');
			assert.ok(next[0].delay > firstDelay, 'the backoff continues instead of restarting');
		});

		it('a canary that neither connects nor fails is given up on', async () => {
			const { paths, pending, fire } = harness();
			const a = waiter('a');
			paths.failed(PRIVATE, a);
			await fire(pending()[0]);
			const [canaryTimeout] = pending();
			assert.strictEqual(canaryTimeout.delay, 60_000);
			await fire(canaryTimeout);
			assert.strictEqual(paths.choose(PUBLIC, PRIVATE, a).path, PATH_PUBLIC_FALLBACK);
			assert.strictEqual(pending().length, 1, 'probing resumes');
		});

		it('skips waiters that have left the fallback, and stops when none remain', async () => {
			const { paths, pending, fire } = harness();
			const gone = waiter('gone', { promotable: false });
			const live = waiter('live');
			paths.failed(PRIVATE, gone);
			paths.failed(PRIVATE, live);
			await fire(pending()[0]);
			assert.strictEqual(live.promotions, 1, 'the next waiter becomes the canary');
			paths.forget(PRIVATE, live);
			assert.strictEqual(pending().length, 1, 'forgetting the canary resumes probing');
			await fire(pending()[0]);
			assert.strictEqual(pending().length, 0, 'no waiters, no more probes');
			assert.strictEqual(paths.choose(PUBLIC, PRIVATE, live).path, PATH_PRIVATE, 'the URL is tried again');
		});

		it('a probe that throws counts as unreachable', async () => {
			const { paths, pending, fire } = harness();
			const a = waiter('a');
			a.probePrivatePath = async () => {
				throw new Error('boom');
			};
			paths.failed(PRIVATE, a);
			await fire(pending()[0]);
			assert.strictEqual(a.promotions, 0);
			assert.strictEqual(pending().length, 1);
		});

		it('a failure reported while a probe is in flight does not start a second probe', async () => {
			const { paths, pending, fire } = harness();
			let resolveProbe;
			const a = waiter('a');
			a.probePrivatePath = () => new Promise((resolve) => (resolveProbe = resolve));
			paths.failed(PRIVATE, a);
			await fire(pending()[0]);
			paths.failed(PRIVATE, waiter('b'));
			assert.strictEqual(pending().length, 0);
			resolveProbe(false);
			await new Promise((resolve) => setImmediate(resolve));
			assert.strictEqual(pending().length, 1);
		});
	});
});
