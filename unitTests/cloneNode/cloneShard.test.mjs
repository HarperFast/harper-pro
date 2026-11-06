import assert from 'node:assert';
import {
	assertResumedShard,
	chooseCloneShard,
	CloneShardRefusedError,
	leaderShardMembers,
	parseShardOption,
	pickAutoShard,
	requireLeaderMaps,
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
		it('reads a number, including 0, and "auto"; unset and empty mean no option', () => {
			assert.equal(parseShardOption('1'), 1);
			assert.equal(parseShardOption('0'), 0);
			assert.equal(parseShardOption(2), 2);
			assert.equal(parseShardOption('auto'), 'auto');
			assert.equal(parseShardOption(undefined), undefined);
			assert.equal(parseShardOption(''), undefined);
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
			assert.equal(pickAutoShard([0, 1], [live(0), live(1), live(1)]), 0);
			assert.equal(pickAutoShard([0, 1], [live(0), live(0), live(1)]), 1);
		});

		it('takes the lowest shard number on a tie, whatever the list order', () => {
			assert.equal(pickAutoShard([1, 0], [live(0), live(1)]), 0);
			assert.equal(pickAutoShard([2, 1], []), 1);
		});

		it('counts only live members', () => {
			assert.equal(pickAutoShard([0, 1], [live(0), live(0), live(1), offline(1), offline(1)]), 1);
		});

		it('fills a shard with no members at all', () => {
			assert.equal(pickAutoShard([0, 1, 2], [live(0), live(1)]), 2);
		});

		it('passes over a shard whose members are all offline: nothing to copy its owned slots from', () => {
			assert.equal(pickAutoShard([0, 1], [live(0), offline(1)]), 0);
		});

		it('never adds a shard: a member outside the list is ignored', () => {
			assert.equal(pickAutoShard([0, 1], [live(0), live(1), live(1), live(7)]), 0);
		});

		it('answers nothing when every shard has only offline members', () => {
			assert.equal(pickAutoShard([0, 1], [offline(0), offline(1)]), undefined);
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
			assert.deepEqual(leaderShardMembers(0, { connections: [] }, 'new-node'), [{ shard: 0, live: true }]);
		});

		it('reads a peer live from any connected socket, and skips this node and unsharded peers', () => {
			assert.deepEqual(leaderShardMembers(undefined, status, 'new-node'), [
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
			assert.strictEqual(chosen({ leaderStatus: { sharding: { data: {} } } }), undefined);
		});

		it('honors an explicit number, shard 0 included', () => {
			assert.equal(chosen({ ...SHARDED, requested: '1' }), 1);
			assert.equal(chosen({ ...SHARDED, requested: '0' }), 0);
		});

		it('refuses a shard the leader does not list', () => {
			refuses({ ...SHARDED, requested: '5' }, /Shard 5 is not in the leader's replication.shards \[0, 1\]/);
			refuses({ ...SHARDED, configured: 5 }, /Shard 5 is not in/);
		});

		it('keeps an explicit shard with no list to check against', () => {
			assert.equal(chosen({ leaderShard: 0, requested: '7' }), 7);
		});

		it("takes this node's configured shard with no option", () => {
			assert.equal(chosen({ ...SHARDED, configured: 1 }), 1);
			assert.equal(chosen({ ...SHARDED, configured: '1' }), 1);
			assert.equal(chosen({ ...SHARDED, configured: 0 }), 0);
		});

		it('refuses an explicit shard that disagrees with the configuration, instead of ignoring either', () => {
			refuses(
				{ ...SHARDED, requested: '1', configured: 0 },
				/asks for shard 1 but this node is configured for shard 0/
			);
			assert.equal(chosen({ ...SHARDED, requested: '1', configured: 1 }), 1);
		});

		it('keeps an existing choice on "auto", so a restart does not re-pick from a changed view', () => {
			assert.equal(chosen({ ...SHARDED, requested: 'auto', configured: 1, leaderStatus: { connections: [] } }), 1);
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
			assert.equal(result.shard, 0);
			assert.equal(result.description, 'shard 0 from "auto"; live members: 0=1, 1=2');
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
				assert.equal(chosen({ ...unproven, requested: '0' }), 0);
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
			assert.deepEqual(requireLeaderMaps(['a', 'b'], [map('b'), map('a')]), [map('b'), map('a')]);
			assert.deepEqual(requireLeaderMaps([], []), []);
		});

		it('names a database the read left out: search_by_id omits a missing row', () => {
			assert.throws(() => requireLeaderMaps(['a', 'b'], [map('a')]), /reports b as sharded but has no shard map/);
		});

		it('refuses an answer that is not a list', () => {
			assert.throws(() => requireLeaderMaps(['a'], { error: 'no' }), /answered its shard map read with object/);
		});
	});
});
