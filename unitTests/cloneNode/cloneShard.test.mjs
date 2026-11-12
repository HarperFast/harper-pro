import assert from 'node:assert';
import {
	assertResumedShard,
	chooseCloneShard,
	CloneShardRefusedError,
	leaderShardMembers,
	parseShardOption,
	pickAutoShard,
	pickReplicaShard,
	requireLeaderMaps,
	slotOwningShards,
} from '#src/cloneNode/cloneShard';

const refuses = (input, message) =>
	assert.throws(
		() => chooseCloneShard({ thisNode: 'new-node', ...input }),
		(error) => {
			assert.ok(error instanceof CloneShardRefusedError, String(error));
			assert.match(error.message, message);
			return true;
		}
	);
const chosen = (input) => chooseCloneShard({ thisNode: 'new-node', ...input }).shard;

const SHARDED = { leaderShard: 0, leaderShards: [0, 1] };

describe('cloneShard', () => {
	describe('parseShardOption', () => {
		it('reads a number, including 0, "auto" and "replica"; unset and empty mean no option', () => {
			assert.strictEqual(parseShardOption('replica'), 'replica');
			assert.strictEqual(parseShardOption('1'), 1);
			assert.strictEqual(parseShardOption('0'), 0);
			assert.strictEqual(parseShardOption(2), 2);
			assert.strictEqual(parseShardOption('auto'), 'auto');
			assert.strictEqual(parseShardOption(undefined), undefined);
			assert.strictEqual(parseShardOption(''), undefined);
		});

		for (const bad of ['abc', '1.5', '-1', '65536', ' ']) {
			it(`refuses ${JSON.stringify(bad)}, naming the option`, () => {
				assert.throws(() => parseShardOption(bad), /--shard or CLONE_SHARD must be an integer/);
			});
		}
	});

	describe('pickAutoShard', () => {
		const live = (shard) => ({ shard, live: true });
		const offline = (shard) => ({ shard, live: false });

		it('picks the listed shard with the fewest live members', () => {
			assert.strictEqual(pickAutoShard([0, 1], [live(0), live(1), live(1)]), 0);
			assert.strictEqual(pickAutoShard([0, 1], [live(0), live(0), live(1)]), 1);
		});

		it('takes the lowest shard number on a tie, whatever the list order', () => {
			assert.strictEqual(pickAutoShard([1, 0], [live(0), live(1)]), 0);
			assert.strictEqual(pickAutoShard([2, 1], []), 1);
		});

		it('counts only live members', () => {
			assert.strictEqual(pickAutoShard([0, 1], [live(0), live(0), live(1), offline(1), offline(1)]), 1);
		});

		it('fills a shard with no members at all', () => {
			assert.strictEqual(pickAutoShard([0, 1, 2], [live(0), live(1)]), 2);
		});

		it('passes over a shard whose members are all offline: nothing to copy its owned slots from', () => {
			assert.strictEqual(pickAutoShard([0, 1], [live(0), offline(1)]), 0);
		});

		it('never adds a shard: a member outside the list is ignored', () => {
			assert.strictEqual(pickAutoShard([0, 1], [live(0), live(1), live(1), live(7)]), 0);
		});

		it('answers nothing when every shard has only offline members', () => {
			assert.strictEqual(pickAutoShard([0, 1], [offline(0), offline(1)]), undefined);
		});

		it('skips a spare shard owning no slots, however few members it has', () => {
			const owning = new Set([0]);
			assert.strictEqual(pickAutoShard([0, 1, 2, 3], [live(0), live(0), live(0)], owning), 0);
			assert.strictEqual(pickAutoShard([0, 1, 2], [live(0), live(2), live(2)], new Set([0, 2])), 0);
			assert.strictEqual(pickAutoShard([0, 1, 2], [live(0), live(0), live(2)], new Set([0, 2])), 2);
		});

		it('answers nothing when every owning shard has only offline members, spares or not', () => {
			assert.strictEqual(pickAutoShard([0, 1], [offline(0), live(1)], new Set([0])), undefined);
		});
	});

	describe('pickReplicaShard', () => {
		const live = (shard) => ({ shard, live: true });
		const offline = (shard) => ({ shard, live: false });
		const owning = new Set([0]);

		it('takes the spare with the most live members, so replica nodes group', () => {
			assert.strictEqual(pickReplicaShard([0, 1, 2, 3], [live(0), live(2), live(2), live(3)], owning), 2);
		});

		it('takes the lowest spare on a tie, whatever the list order', () => {
			assert.strictEqual(pickReplicaShard([3, 0, 2, 1], [live(0)], owning), 1);
			assert.strictEqual(pickReplicaShard([0, 1, 2], [live(1), live(2)], owning), 1);
		});

		it('counts only live members, and keeps a spare whose members are all offline', () => {
			assert.strictEqual(pickReplicaShard([0, 1, 2], [live(1), offline(2), offline(2)], owning), 1);
			assert.strictEqual(pickReplicaShard([0, 1], [offline(1)], owning), 1);
		});

		it('never picks a shard owning slots', () => {
			assert.strictEqual(pickReplicaShard([0, 1], [live(1)], new Set([0, 1])), undefined);
		});
	});

	describe('slotOwningShards', () => {
		const map = (database, ranges) => ({ database, slots: 10, ranges });

		it('collects the shards owning slots across every map', () => {
			assert.deepStrictEqual(
				[
					...slotOwningShards([
						map('a', [{ start: 0, end: 10, shard: 0 }]),
						map('b', [
							{ start: 0, end: 4, shard: 0 },
							{ start: 4, end: 10, shard: 2 },
						]),
					]),
				].sort(),
				[0, 2]
			);
		});

		it('has nothing to read with no maps', () => {
			assert.strictEqual(slotOwningShards([]), undefined);
			assert.strictEqual(slotOwningShards(undefined), undefined);
		});

		it('refuses a malformed map rather than reading it as owning nothing', () => {
			assert.throws(() => slotOwningShards([{ database: 'a' }]), /'a' has no slot ranges/);
			assert.throws(() => slotOwningShards([map('a', [{ start: 0, end: 10 }])]), /'a' has a range with no shard/);
		});
	});

	describe('leaderShardMembers', () => {
		const status = {
			connections: [
				{ name: 'b', shard: 1, database_sockets: [{ connected: false }, { connected: true }] },
				{ name: 'c', shard: 0, database_sockets: [{ connected: false }] },
				{ name: 'unsharded', database_sockets: [{ connected: true }] },
				{ name: 'new-node', shard: 0, database_sockets: [{ connected: true }] },
			],
		};

		it('counts the leader, shard 0 included, which has no row of its own in its connections', () => {
			assert.deepStrictEqual(leaderShardMembers(0, { connections: [] }, 'new-node'), [{ shard: 0, live: true }]);
		});

		it('reads a peer live from any connected socket, and skips this node and unsharded peers', () => {
			assert.deepStrictEqual(leaderShardMembers(undefined, status, 'new-node'), [
				{ shard: 1, live: true },
				{ shard: 0, live: false },
			]);
		});
	});

	describe('chooseCloneShard', () => {
		it('refuses a sharded leader with no option, naming the option and the shards', () => {
			refuses(SHARDED, /--shard or CLONE_SHARD.*\[0, 1\]/);
			refuses({ leaderShard: 0 }, /a clone does not inherit its shard/);
			refuses({ leaderShards: [0, 1] }, /a clone does not inherit its shard/);
		});

		it('never returns the leader shard unasked: shard 0 counts as a sharded leader', () => {
			refuses({ leaderShard: 0, leaderShards: undefined }, /--shard or CLONE_SHARD/);
		});

		it('leaves an unsharded leader alone', () => {
			assert.strictEqual(chosen({}), undefined);
			assert.strictEqual(chosen({ requested: 'auto' }), undefined);
		});

		it('lets a clone of a leader holding no slots hold none either, with no option', () => {
			const result = chooseCloneShard({ thisNode: 'new-node', leaderStatus: { sharding: { data: {} } } });
			assert.strictEqual(result.shard, undefined);
			assert.strictEqual(result.description, 'no shard: the leader owns no slots, so this node will own none');
		});

		it('honors an explicit number, shard 0 included', () => {
			assert.strictEqual(chosen({ ...SHARDED, requested: '1' }), 1);
			assert.strictEqual(chosen({ ...SHARDED, requested: '0' }), 0);
		});

		it('refuses a shard the leader does not list', () => {
			refuses({ ...SHARDED, requested: '5' }, /Shard 5 is not in the leader's replication.shards \[0, 1\]/);
			refuses({ ...SHARDED, configured: 5 }, /Shard 5 is not in/);
		});

		it('keeps an explicit shard with no list to check against', () => {
			assert.strictEqual(chosen({ leaderShard: 0, requested: '7' }), 7);
		});

		it("takes this node's configured shard with no option", () => {
			assert.strictEqual(chosen({ ...SHARDED, configured: 1 }), 1);
			assert.strictEqual(chosen({ ...SHARDED, configured: '1' }), 1);
			assert.strictEqual(chosen({ ...SHARDED, configured: 0 }), 0);
		});

		it('refuses an explicit shard that disagrees with the configuration, instead of ignoring either', () => {
			refuses(
				{ ...SHARDED, requested: '1', configured: 0 },
				/asks for shard 1 but this node is configured for shard 0/
			);
			assert.strictEqual(chosen({ ...SHARDED, requested: '1', configured: 1 }), 1);
		});

		it('keeps an existing choice on "auto", so a restart does not re-pick from a changed view', () => {
			assert.strictEqual(
				chosen({ ...SHARDED, requested: 'auto', configured: 1, leaderStatus: { connections: [] } }),
				1
			);
		});

		it('resolves "auto" from the leader\'s members and describes the choice', () => {
			const result = chooseCloneShard({
				...SHARDED,
				requested: 'auto',
				thisNode: 'new-node',
				leaderStatus: {
					connections: [
						{ name: 'b', shard: 1, database_sockets: [{ connected: true }] },
						{ name: 'c', shard: 1, database_sockets: [{ connected: true }] },
					],
				},
			});
			assert.strictEqual(result.shard, 0);
			assert.strictEqual(result.description, 'shard 0 from "auto"; live members: 0=1, 1=2');
		});

		it('refuses "auto" with no list to fill, naming the option', () => {
			refuses({ leaderShard: 0, requested: 'auto' }, /"auto" only fills shards listed.*--shard or CLONE_SHARD/);
			refuses({ requested: 'auto', leaderStatus: { sharding: { data: {} } } }, /"auto" only fills shards listed/);
		});

		it('refuses "auto" when no listed shard has a source to copy from', () => {
			refuses(
				{
					leaderShards: [1, 2],
					requested: 'auto',
					leaderStatus: {
						connections: [
							{ name: 'b', shard: 1, database_sockets: [] },
							{ name: 'c', shard: 2, database_sockets: [] },
						],
					},
				},
				/"auto" found no listed shard with a live member/
			);
		});

		describe('with spare shard IDs listed', () => {
			const BACKBONE = {
				leaderShard: 0,
				leaderShards: [0, 1, 2, 3],
				leaderMaps: [{ database: 'data', slots: 10, ranges: [{ start: 0, end: 10, shard: 0 }] }],
			};
			const status = (...shards) => ({
				connections: shards.map((shard, i) => ({
					name: `peer-${i}`,
					shard,
					database_sockets: [{ connected: true }],
				})),
			});

			it('"auto" joins the shard owning slots, not an empty spare', () => {
				const result = chooseCloneShard({
					...BACKBONE,
					requested: 'auto',
					thisNode: 'new-node',
					leaderStatus: status(0, 0),
				});
				assert.strictEqual(result.shard, 0);
				assert.strictEqual(
					result.description,
					'shard 0 from "auto"; live members: 0=3, 1=0, 2=0, 3=0; shards owning slots: [0]'
				);
			});

			it('"replica" joins the lowest spare when no spare has members', () => {
				assert.strictEqual(chosen({ ...BACKBONE, requested: 'replica', leaderStatus: status(0, 0) }), 1);
			});

			it('"replica" joins the spare other replica nodes already hold', () => {
				assert.strictEqual(chosen({ ...BACKBONE, requested: 'replica', leaderStatus: status(0, 3, 3, 2) }), 3);
			});

			it('keeps this node\'s configured shard on "replica", as on "auto"', () => {
				assert.strictEqual(chosen({ ...BACKBONE, requested: 'replica', configured: 2, leaderStatus: status() }), 2);
			});

			it('refuses "replica" when every listed shard owns slots, naming the owners', () => {
				refuses(
					{
						...BACKBONE,
						leaderShards: [0, 1],
						leaderMaps: [
							{
								database: 'data',
								slots: 10,
								ranges: [
									{ start: 0, end: 5, shard: 0 },
									{ start: 5, end: 10, shard: 1 },
								],
							},
						],
						requested: 'replica',
						leaderStatus: status(),
					},
					/"replica" found no listed shard owning no slots.*\[0, 1\].*shards owning slots: \[0, 1\]; list a spare/
				);
			});

			it('refuses "replica" with no map: the default map gives every listed shard slots', () => {
				refuses(
					{ ...BACKBONE, leaderMaps: [], requested: 'replica', leaderStatus: status() },
					/no shard map and no replication.spareShards/
				);
			});

			it('refuses "replica" with no list, as "auto" does', () => {
				refuses({ leaderShard: 0, requested: 'replica' }, /"replica" only fills shards listed/);
				refuses({ requested: 'replica' }, /"replica" only fills shards listed/);
			});

			it('reads spares from replication.spareShards before any map is installed', () => {
				const noMap = { ...BACKBONE, leaderMaps: [], leaderSpareShards: [1, 2, 3] };
				assert.strictEqual(chosen({ ...noMap, requested: 'replica', leaderStatus: status(0, 0) }), 1);
				assert.strictEqual(chosen({ ...noMap, requested: 'auto', leaderStatus: status(0, 0) }), 0);
			});

			it('lets the installed map decide once there is one', () => {
				assert.strictEqual(
					chosen({ ...BACKBONE, leaderSpareShards: [3], requested: 'replica', leaderStatus: status(0, 0) }),
					1
				);
			});

			it('refuses a malformed replication.spareShards from the leader', () => {
				refuses(
					{ ...BACKBONE, leaderMaps: [], leaderSpareShards: 'one', requested: 'replica', leaderStatus: status() },
					/replication.spareShards is not a list/
				);
			});

			it('"auto" refuses when every owning shard is offline, rather than picking a spare', () => {
				refuses(
					{
						...BACKBONE,
						leaderShard: undefined,
						requested: 'auto',
						leaderStatus: {
							connections: [
								{ name: 'b', shard: 0, database_sockets: [] },
								{ name: 'c', shard: 2, database_sockets: [{ connected: true }] },
							],
						},
					},
					/"auto" found no listed shard with a live member.*shards owning slots: \[0\]/
				);
			});
		});

		it('refuses a malformed shard from the leader or the configuration', () => {
			refuses({ leaderShards: 'zero', requested: '0' }, /replication.shards is not a list/);
			refuses({ leaderShards: [0, 'one'], requested: '0' }, /replication.shards entry/);
			refuses({ ...SHARDED, configured: 'one' }, /replication.shard must be/);
		});

		describe('a config-file shard an older clone attempt wrote', () => {
			const unproven = { ...SHARDED, configured: 0, configuredUnproven: true };

			it('is not read as the operator choosing the leader shard', () => {
				refuses(unproven, /may be the leader's own shard.*--shard or CLONE_SHARD/);
			});

			it('is not kept by "auto" either', () => {
				refuses({ ...unproven, requested: 'auto' }, /may be the leader's own shard/);
			});

			it('stands once the operator confirms it', () => {
				assert.strictEqual(chosen({ ...unproven, requested: '0' }), 0);
			});

			it('refuses a different explicit shard: that root may already have joined as the first', () => {
				refuses({ ...unproven, requested: '1' }, /may be the leader's own shard/);
			});
		});
	});

	describe('assertResumedShard', () => {
		it('passes when nothing disagrees with the shard the clone started as', () => {
			assertResumedShard({ durable: 1, requested: '1', configured: 1, joined: true });
			assertResumedShard({ durable: 0, requested: 'auto', configured: '0', joined: true });
		});

		it('refuses a different explicit option', () => {
			assert.throws(
				() => assertResumedShard({ durable: 1, requested: '0', configured: 1, joined: true }),
				/--shard or CLONE_SHARD says shard 0 but this clone is in progress as shard 1/
			);
		});

		it('refuses a configuration that now says otherwise, whatever the option', () => {
			assert.throws(
				() => assertResumedShard({ durable: 1, requested: 'auto', configured: 0, joined: true }),
				/replication.shard says shard 0 but this clone is in progress as shard 1/
			);
		});

		it('refuses a joined clone whose configuration lost the shard: setup will not write it back', () => {
			assert.throws(
				() => assertResumedShard({ durable: 1, requested: 'auto', configured: undefined, joined: true }),
				/replication.shard is missing but this clone is in progress as shard 1/
			);
		});

		it('allows a clone not yet joined to be missing it: a crash can land between the marker and the config', () => {
			assertResumedShard({ durable: 1, requested: undefined, configured: undefined, joined: false });
		});

		it('has nothing to enforce when the clone took no shard', () => {
			assertResumedShard({ durable: undefined, requested: undefined, configured: 3, joined: true });
		});
	});

	describe('requireLeaderMaps', () => {
		const map = (database) => ({ database, version: 1 });

		it('returns the maps when every requested database has one', () => {
			assert.deepStrictEqual(requireLeaderMaps(['a', 'b'], [map('b'), map('a')]), [map('b'), map('a')]);
			assert.deepStrictEqual(requireLeaderMaps([], []), []);
		});

		it('names a database the read left out: search_by_id omits a missing row', () => {
			assert.throws(() => requireLeaderMaps(['a', 'b'], [map('a')]), /reports b as sharded but has no shard map/);
		});

		it('refuses an answer that is not a list', () => {
			assert.throws(() => requireLeaderMaps(['a'], { error: 'no' }), /answered its shard map read with object/);
		});
	});
});
