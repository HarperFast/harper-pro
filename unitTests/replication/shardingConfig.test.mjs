import assert from 'node:assert';
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once, EventEmitter } from 'node:events';
import { getResidencyConfiguration } from '#src/core/resources/residencyMaps';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';
import { RootConfigWatcher } from '#src/core/config/RootConfigWatcher';
import { getConfigValue, updateConfigObject } from '#src/core/config/configUtils';
import { watchShardingConfiguration, onShardingConfigurationChange } from '#src/core/config/shardingConfiguration';

async function until(predicate) {
	const end = Date.now() + 10_000;
	while (!predicate()) {
		assert.ok(Date.now() < end, 'shard-list projection did not converge');
		await delay(20);
	}
}

describe('Sharding config projection on an existing worker', function () {
	this.timeout(20_000);
	for (const readyFirst of [false, true])
		it(`repairs the shard list without replacing the observer (already ready=${readyFirst})`, async () => {
			const root = mkdtempSync(join(tmpdir(), 'sharding-watch-'));
			const path = join(root, 'config.yaml');
			const previousShard = getConfigValue('replication_shard');
			const previousShards = getConfigValue('replication_shards');
			updateConfigObject('replication_shard', 0);
			updateConfigObject('replication_shards', [0, 1]);
			writeFileSync(path, stringify({ replication: { shard: 0, shards: [1] } }));
			const watcher = new RootConfigWatcher(path);
			let changes = 0;
			const unlisten = onShardingConfigurationChange(() => changes++);
			let stop;
			try {
				if (readyFirst) await watcher.ready;
				const watch = watchShardingConfiguration(watcher);
				stop = watch.stop;
				await watch.ready;
				await until(() => getConfigValue('replication_shards')?.length === 1);
				assert.equal(changes, 1);
				async function replace(config, expectedChanges) {
					const changed = once(watcher, 'change', { signal: AbortSignal.timeout(5000) });
					writeFileSync(path + '.next', stringify(config));
					renameSync(path + '.next', path);
					await changed;
					if (expectedChanges === undefined) await delay(250);
					else await until(() => changes === expectedChanges);
				}
				await replace({ replication: { shard: 0, shards: [0, 1] } }, 2);
				assert.deepEqual(getConfigValue('replication_shards'), [0, 1]);
				assert.equal(changes, 2);
				const identity = getConfigValue('replication_shards');
				const placementIdentity = getResidencyConfiguration();
				await replace({ logging: { level: 'error' }, replication: { shard: 0, shards: [0, 1] } });
				assert.equal(getConfigValue('replication_shards'), identity, 'unrelated writes preserve the cached topology');
				assert.equal(changes, 2);
				await replace({ replication: { shard: 0, shards: [1, 0] } });
				assert.equal(changes, 2, 'reordering shard IDs does not reconnect peers');
				assert.equal(getResidencyConfiguration(), placementIdentity);
				await replace({ replication: { shard: 2, shards: [1, 2] } });
				assert.equal(
					getConfigValue('replication_shards'),
					identity,
					'a planned node-identity change waits for restart'
				);
				await replace({ replication: 5 });
				assert.equal(getConfigValue('replication_shards'), identity);
				await replace({ replication: { shard: 0 } }, 3);
				assert.equal(getConfigValue('replication_shards'), undefined, 'optional list removal is observed');
				assert.equal(changes, 3);
			} finally {
				stop?.();
				unlisten();
				watcher.close();
				updateConfigObject('replication_shard', previousShard);
				updateConfigObject('replication_shards', previousShards);
				rmSync(root, { recursive: true, force: true });
			}
		});
	it('contains observer failures and detaches a closed watcher before its pending repair', async () => {
		const previousShard = getConfigValue('replication_shard');
		const previousShards = getConfigValue('replication_shards');
		const watcher = Object.assign(new EventEmitter(), {
			ready: Promise.resolve(),
			config: { replication: { shard: 0, shards: [0, 1] } },
		});
		updateConfigObject('replication_shard', 0);
		updateConfigObject('replication_shards', [0]);
		let observed = 0;
		const stops = [
			onShardingConfigurationChange(() => {
				throw new Error('injected observer throw');
			}),
			onShardingConfigurationChange(async () => {
				throw new Error('injected observer rejection');
			}),
			onShardingConfigurationChange(() => {
				observed++;
			}),
		];
		const watch = watchShardingConfiguration(watcher);
		try {
			await watch.ready;
			assert.equal(observed, 1, 'one failing listener cannot prevent later listeners from repairing');
			assert.deepEqual(getConfigValue('replication_shards'), [0, 1]);
			watcher.config = { replication: { shard: 0, shards: [0] } };
			watcher.emit('change');
			watcher.emit('close');
			await delay(250);
			assert.deepEqual(getConfigValue('replication_shards'), [0, 1]);
			assert.equal(observed, 1);
			for (const event of ['change', 'error', 'close']) assert.equal(watcher.listenerCount(event), 0);
		} finally {
			watch.stop();
			for (const stop of stops) stop();
			updateConfigObject('replication_shard', previousShard);
			updateConfigObject('replication_shards', previousShards);
		}
	});

	it('handles an initial read failure and removes its watcher listeners on stop', async () => {
		const watcher = Object.assign(new EventEmitter(), {
			ready: Promise.reject(new Error('injected initial read failure')),
		});
		const watch = watchShardingConfiguration(watcher);
		try {
			await watch.ready;
			assert.doesNotThrow(() => watcher.emit('error', new Error('injected watch failure')));
		} finally {
			watch.stop();
		}
		for (const event of ['change', 'error', 'close']) assert.equal(watcher.listenerCount(event), 0);
	});
});
