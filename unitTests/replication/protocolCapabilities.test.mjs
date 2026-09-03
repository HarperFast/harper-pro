/**
 * The load-bearing property here is that the registry reproduces `capabilities?.subscriptionSetupAck >= 1`
 * exactly for every input that comparison could see — a coercing comparison accepts more than integers.
 */
import assert from 'node:assert';
import { inspect } from 'node:util';
import { decode, encode } from 'msgpackr';
import {
	ABSENT_PEER_CAPABILITIES,
	LOCAL_PROTOCOL_VERSION,
	MINIMUM_PROTOCOL_VERSION,
	SUBSCRIPTION_SETUP_ACK_CAPABILITY,
	buildLocalCapabilities,
	createUnknownCommandState,
	noteUnknownCommand,
	resolvePeerCapabilities,
	samePeerCapabilities,
	subscriptionSetupCapabilityFrom,
} from '#src/replication/protocolCapabilities';
import { resolveSubscriptionSetupCapability } from '#src/replication/replicationConnection';

const NODE_NAME = 140;

describe('resolvePeerCapabilities — absent and legacy shapes', () => {
	it('resolves an absent bag to the pre-registry defaults', () => {
		assert.deepStrictEqual(
			{ ...resolvePeerCapabilities(undefined) },
			{
				protocolVersion: MINIMUM_PROTOCOL_VERSION,
				subscriptionSetupAck: 0,
				subscriptionSetupBudgetMs: undefined,
			}
		);
	});

	it('treats a four-element legacy NODE_NAME frame (no capability element) as absent', () => {
		const legacyFrame = [NODE_NAME, 'peer', 'data', []];
		assert.deepStrictEqual({ ...resolvePeerCapabilities(legacyFrame[4]) }, { ...ABSENT_PEER_CAPABILITIES });
	});

	it('reads a #646-shape bag that predates protocolVersion', () => {
		const resolved = resolvePeerCapabilities({ subscriptionSetupAck: 1, subscriptionSetupBudgetMs: 300 });
		assert.strictEqual(resolved.protocolVersion, MINIMUM_PROTOCOL_VERSION);
		assert.strictEqual(resolved.subscriptionSetupAck, 1);
		assert.strictEqual(resolved.subscriptionSetupBudgetMs, 300);
	});

	it('drops keys this build does not know instead of carrying them', () => {
		const resolved = resolvePeerCapabilities({ subscriptionSetupAck: 1, recordLocks: 3, somethingElse: 'x' });
		assert.deepStrictEqual(Object.keys(resolved).sort(), [
			'protocolVersion',
			'subscriptionSetupAck',
			'subscriptionSetupBudgetMs',
		]);
	});

	it('returns a frozen object', () => {
		const resolved = resolvePeerCapabilities({ subscriptionSetupAck: 1 });
		assert.strictEqual(Object.isFrozen(resolved), true);
		assert.throws(() => {
			'use strict';
			resolved.subscriptionSetupAck = 9;
		}, TypeError);
	});
});

describe('resolvePeerCapabilities — protocolVersion', () => {
	it('takes the lower of the local and peer versions', () => {
		assert.strictEqual(resolvePeerCapabilities({ protocolVersion: 5 }).protocolVersion, LOCAL_PROTOCOL_VERSION);
		assert.strictEqual(
			resolvePeerCapabilities({ protocolVersion: LOCAL_PROTOCOL_VERSION }).protocolVersion,
			LOCAL_PROTOCOL_VERSION
		);
		assert.strictEqual(resolvePeerCapabilities({ protocolVersion: 1 }).protocolVersion, 1);
	});

	it('floors an absent, unusable, or below-minimum version at the minimum', () => {
		for (const advertised of [undefined, null, 0, -3, 'v2', {}, NaN]) {
			assert.strictEqual(
				resolvePeerCapabilities({ protocolVersion: advertised }).protocolVersion,
				MINIMUM_PROTOCOL_VERSION,
				`advertised ${String(advertised)}`
			);
		}
	});

	it('is the descriptive absent-default and gates nothing on its own', () => {
		assert.strictEqual(ABSENT_PEER_CAPABILITIES.protocolVersion, MINIMUM_PROTOCOL_VERSION);
	});
});

describe('resolvePeerCapabilities — subscriptionSetupAck preserves the pre-registry comparison', () => {
	// The behavior being preserved is `capabilities?.subscriptionSetupAck >= SUBSCRIPTION_SETUP_ACK_CAPABILITY`,
	// which coerces its operand. Each row asserts the registry agrees with that comparison on the raw value.
	const advertised = [
		1,
		2,
		1.5,
		0,
		0.5,
		-1,
		true,
		false,
		'1',
		'2',
		'0',
		null,
		undefined,
		{},
		[],
		['2'],
		Infinity,
		-Infinity,
		NaN,
	];

	for (const value of advertised) {
		it(`agrees with the raw >= comparison for ${inspect(value)}`, () => {
			const legacySupported = value >= SUBSCRIPTION_SETUP_ACK_CAPABILITY;
			const resolved = resolvePeerCapabilities({ subscriptionSetupAck: value });
			assert.strictEqual(
				resolved.subscriptionSetupAck >= SUBSCRIPTION_SETUP_ACK_CAPABILITY,
				legacySupported,
				`raw ${String(value)} -> resolved ${resolved.subscriptionSetupAck}`
			);
		});
	}

	it('never reports a level above the one this build implements', () => {
		assert.strictEqual(
			resolvePeerCapabilities({ subscriptionSetupAck: 99 }).subscriptionSetupAck,
			SUBSCRIPTION_SETUP_ACK_CAPABILITY
		);
	});
});

describe('resolvePeerCapabilities — subscriptionSetupBudgetMs is a parameter, not a level', () => {
	it('accepts only a raw finite positive number, exactly as the pre-registry check did', () => {
		for (const value of [null, undefined, NaN, '300', -1, 0, Infinity, -Infinity, true, {}, []]) {
			assert.strictEqual(
				resolvePeerCapabilities({ subscriptionSetupBudgetMs: value }).subscriptionSetupBudgetMs,
				undefined,
				`advertised ${String(value)}`
			);
		}
		assert.strictEqual(resolvePeerCapabilities({ subscriptionSetupBudgetMs: 300 }).subscriptionSetupBudgetMs, 300);
	});

	it('is not min-clamped against the local advertised budget', () => {
		const local = buildLocalCapabilities(1000);
		const resolved = resolvePeerCapabilities({ subscriptionSetupBudgetMs: 900_000 });
		assert.ok(resolved.subscriptionSetupBudgetMs > local.subscriptionSetupBudgetMs);
		assert.strictEqual(resolved.subscriptionSetupBudgetMs, 900_000);
	});
});

describe('subscriptionSetupCapabilityFrom', () => {
	it('always yields a finite positive timeout the watchdog can schedule', () => {
		for (const bag of [
			undefined,
			{},
			{ subscriptionSetupAck: 1 },
			{ subscriptionSetupAck: 1, subscriptionSetupBudgetMs: NaN },
		]) {
			const { timeoutMs } = subscriptionSetupCapabilityFrom(resolvePeerCapabilities(bag), 150, true);
			assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, `bag ${JSON.stringify(bag)} -> ${timeoutMs}`);
			assert.strictEqual(timeoutMs, 150);
		}
	});

	it('clamps a peer budget into [local, max(local*4, 10min)]', () => {
		const at = (budget, local) =>
			subscriptionSetupCapabilityFrom(
				resolvePeerCapabilities({ subscriptionSetupAck: 1, subscriptionSetupBudgetMs: budget }),
				local,
				true
			).timeoutMs;
		assert.strictEqual(at(300, 150), 300); // between the bounds
		assert.strictEqual(at(50, 150), 150); // below the local floor
		assert.strictEqual(at(86_400_000, 150_000), 600_000); // above the ceiling
		assert.strictEqual(at(86_400_000, 200_000), 800_000); // ceiling is local*4 once that exceeds 10min
	});

	it('ignores the peer budget when the local timeout is an explicit test override', () => {
		const resolved = resolvePeerCapabilities({ subscriptionSetupAck: 1, subscriptionSetupBudgetMs: 300 });
		assert.deepStrictEqual(subscriptionSetupCapabilityFrom(resolved, 25, false), { supported: true, timeoutMs: 25 });
	});

	it('agrees with the resolveSubscriptionSetupCapability view exported for the call site', () => {
		for (const bag of [
			undefined,
			{},
			{ subscriptionSetupAck: 1 },
			{ subscriptionSetupAck: 2, subscriptionSetupBudgetMs: 300 },
			{ subscriptionSetupAck: 1, subscriptionSetupBudgetMs: 86_400_000 },
		]) {
			assert.deepStrictEqual(
				resolveSubscriptionSetupCapability(bag, 150),
				subscriptionSetupCapabilityFrom(resolvePeerCapabilities(bag), 150, true),
				`bag ${JSON.stringify(bag)}`
			);
		}
	});
});

describe('buildLocalCapabilities / the advertised NODE_NAME frame', () => {
	it('advertises exactly the registry keys, frozen', () => {
		const local = buildLocalCapabilities(90_000);
		assert.deepStrictEqual(
			{ ...local },
			{
				protocolVersion: LOCAL_PROTOCOL_VERSION,
				subscriptionSetupAck: SUBSCRIPTION_SETUP_ACK_CAPABILITY,
				subscriptionSetupBudgetMs: 90_000,
			}
		);
		assert.strictEqual(Object.isFrozen(local), true);
	});

	it('round-trips through this node into the pre-registry setup behavior', () => {
		// What a current peer advertises must still enable acknowledgement and carry its budget.
		const resolved = resolvePeerCapabilities(buildLocalCapabilities(90_000));
		assert.strictEqual(resolved.subscriptionSetupAck, SUBSCRIPTION_SETUP_ACK_CAPABILITY);
		assert.strictEqual(resolved.subscriptionSetupBudgetMs, 90_000);
		assert.strictEqual(resolved.protocolVersion, LOCAL_PROTOCOL_VERSION);
	});

	it('keeps the NODE_NAME frame a five-element array whose element 4 is the bag', () => {
		// Guards the outer wire shape only. Backward compatibility is proved by the legacy-shape resolver
		// cases above — a golden of the NEW bytes cannot show that an old reader tolerates them.
		const frame = encode([NODE_NAME, 'this-node', 'data', [], buildLocalCapabilities(90_000)]);
		assert.strictEqual(frame[0] > 127, true, 'first byte must mark this a command frame');
		const decoded = decode(frame);
		assert.strictEqual(decoded.length, 5);
		assert.strictEqual(decoded[0], NODE_NAME);
		assert.deepStrictEqual(
			{ ...decoded[4] },
			{
				protocolVersion: LOCAL_PROTOCOL_VERSION,
				subscriptionSetupAck: SUBSCRIPTION_SETUP_ACK_CAPABILITY,
				subscriptionSetupBudgetMs: 90_000,
			}
		);
	});
});

describe('samePeerCapabilities', () => {
	it('compares field values, not object identity', () => {
		const a = resolvePeerCapabilities({ subscriptionSetupAck: 1, subscriptionSetupBudgetMs: 300 });
		const b = resolvePeerCapabilities({ subscriptionSetupAck: 1, subscriptionSetupBudgetMs: 300 });
		assert.notStrictEqual(a, b, 'each resolution is a fresh object');
		assert.strictEqual(samePeerCapabilities(a, b), true);
	});

	it('reports a change when the peer upgrades or downgrades', () => {
		const legacy = resolvePeerCapabilities(undefined);
		const current = resolvePeerCapabilities(buildLocalCapabilities(90_000));
		assert.strictEqual(samePeerCapabilities(legacy, current), false);
		assert.strictEqual(samePeerCapabilities(current, legacy), false);
	});

	it('treats "never posted" as a change', () => {
		assert.strictEqual(samePeerCapabilities(undefined, ABSENT_PEER_CAPABILITIES), false);
	});
});

describe('noteUnknownCommand', () => {
	it('counts every occurrence on the connection', () => {
		const state = createUnknownCommandState();
		noteUnknownCommand(state, 200);
		assert.strictEqual(state.count, 1);
		noteUnknownCommand(state, 201);
		assert.strictEqual(state.count, 2);
		assert.strictEqual(state.lastCommand, 201);
	});

	it('counts a non-numeric command but never logs it', () => {
		// `decode()` yields whatever the peer put in element 0; `[{}, payload]` reaches this branch.
		const state = createUnknownCommandState();
		for (const command of [{}, 'OPERATION', null, 1.5, Number.MAX_VALUE * 2, [], true]) {
			assert.strictEqual(noteUnknownCommand(state, command), 'non-numeric', `command ${inspect(command)}`);
		}
		assert.strictEqual(state.count, 7);
		assert.strictEqual(state.lastCommand, undefined);
	});

	it('reports a safe integer code as itself', () => {
		assert.strictEqual(noteUnknownCommand(createUnknownCommandState(), 200), 200);
	});

	it('starts a fresh connection at zero, so a reconnect can publish its own count', () => {
		assert.strictEqual(createUnknownCommandState().count, 0);
	});
});
