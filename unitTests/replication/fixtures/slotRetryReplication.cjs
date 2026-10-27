const { createRequire } = require('node:module');
const path = require('node:path');
const { mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { EventEmitter } = require('node:events');
const assert = require('node:assert');
const req = createRequire(path.resolve(__dirname, '../../../package.json'));
const [mode, root, output, sourceFile] = process.argv.slice(2);
const env = req('#src/core/utility/environment/environmentManager');
const terms = req('#src/core/utility/hdbTerms');
env.setProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, root);
env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, path.join(root, 'database'));
env.setProperty('replication_shards', [0, 1]);
env.setProperty('replication_shard', 0);
env.setProperty(terms.CONFIG_PARAMS.LOGGING_AUDITLOG, true);
env.setProperty(terms.CONFIG_PARAMS.NODE_HOSTNAME, mode === 'send' ? 'abort-source' : 'slot0-peer');
mkdirSync(path.join(root, 'database'), { recursive: true });
const { server } = req('#src/core/server/Server');
req('#src/core/server/threads/manageThreads').setMainIsWorker(true);
const { transaction } = req('#src/core/resources/transaction');
const { replicationConfirmation, getOutstandingCommits } = req('#src/core/resources/DatabaseTransaction');
const { table } = req('#src/core/resources/databases');
const { initializeResidencySlots, setResidencyPlacementGuard, getResidencyConfiguration } = req(
	'#src/core/resources/residencyMaps'
);
const { setReplicator } = req('#src/replication/replicator');
const { databaseSubscriptions, replicateOverWS } = req('#src/replication/replicationConnection');
const { buildLocalCapabilities } = req('#src/replication/protocolCapabilities');
const { advanceShardingHistory } = req('#src/replication/shardingBootstrapState');
const { shardingLayout } = req('#src/replication/shardingRecovery');
const { encode, decode } = req('msgpackr');
const { Decoder, readAuditEntry } = req('#src/core/resources/auditStore');
const native = req('@harperfast/rocksdb-js');
if (process.env.HARPER_TEST_ABORT_MARKER_LEGACY_RED === '1') native.Transaction.prototype.usesAbortMarkers = () => true;
else assert.equal(typeof native.Transaction.prototype.usesAbortMarkers, 'function');
native.RocksDatabase.config({ transactionLogAbortMarkers: true });
const helper = require('../../../core/unitTests/resources/fixtures/slotRetryAbort.cjs');
class Socket extends EventEmitter {
	readyState = 1;
	sent = [];
	closes = [];
	_socket = { bytesRead: 0, bytesWritten: 0, setMaxListeners() {} };
	send(data) {
		this.sent.push(Buffer.from(data));
	}
	close(code = 1000, reason = '') {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.closes.push({ code, reason });
		this.emit('close', code, Buffer.from(reason));
	}
	terminate() {
		this.close(1006);
	}
	ping() {}
	pause() {}
	resume() {}
}
async function until(predicate) {
	const end = Date.now() + 10000;
	while (!predicate()) {
		assert.ok(Date.now() < end, 'replication timeout');
		await new Promise((r) => setTimeout(r, 10));
	}
}
function records(socket, Records) {
	const entries = [];
	for (const frame of socket.sent) {
		if (frame[0] > 127) continue;
		const decoder = new Decoder(frame.buffer, frame.byteOffset, frame.byteLength);
		decoder.position = 8;
		while (decoder.position < frame.length) {
			const length = decoder.readInt(),
				start = decoder.position;
			decoder.position += length;
			if (length === 9 && frame[start] === 11) continue;
			const e = readAuditEntry(frame, start, start + length);
			if (e.recordId === 'retry-abort' || e.recordId === 'barrier')
				entries.push({
					type: e.type,
					recordId: e.recordId,
					slot: e.residencySlot,
					version: e.version,
					nodeId: e.nodeId,
					value: e.getValue(Records.primaryStore),
				});
		}
	}
	return entries;
}
(async () => {
	server.shards = new Map([
		[0, [{ name: 'abort-source' }, { name: 'slot0-peer' }]],
		[1, [{ name: 'slot1-owner' }]],
	]);
	server.nodes = [{ name: mode === 'send' ? 'slot0-peer' : 'abort-source', replicates: true }];

	const database = 'slotabort';
	await initializeResidencySlots({
		database,
		slots: 2,
		ranges: [
			{ start: 0, end: 1, shard: 0 },
			{ start: 1, end: 2, shard: 1 },
		],
	});
	const Records = table({
		database,
		table: 'RetryRows',
		audit: true,
		replicaExpiration: 0,
		residency: { slots: 2, by: 'region', byAttribute: true, slotFrom: 'region === 0 ? 0 : zone' },
		attributes: [
			{ name: 'id', isPrimaryKey: true },
			{ name: 'region', indexed: true },
			{ name: 'zone', indexed: true },
			{ name: 'body' },
		],
	});
	if (mode === 'verify') {
		writeFileSync(
			output,
			JSON.stringify(
				{ primary: helper.snapshot(Records), audit: helper.audit(Records, { log: undefined, readUncommitted: true }) },
				null,
				2
			)
		);
		process.exit(0);
	}
	for (const shard of [0, 1])
		advanceShardingHistory(Records.dbisDB, shardingLayout(database, shard), {
			initializer: server.hostname,
			agreement: 'fixture',
			run: 'fixture',
			phase: 'began',
			localFloor: 1,
			localOrigin: server.hostname,
		});
	setReplicator(database, Records, {});
	await until(() => databaseSubscriptions.get(database)?.auditStore);

	const socket = new Socket();
	const peer = mode === 'send' ? 'slot0-peer' : 'abort-source';
	replicateOverWS(socket, {}, { name: peer, replicates: true });
	socket.emit(
		'message',
		encode([
			140,
			peer,
			database,
			[],
			buildLocalCapabilities(90000, true, true),
			{ shardsDigest: getResidencyConfiguration().digest },
		])
	);
	await until(() => socket.sent.some((f) => f[0] > 127 && decode(f)[0] === 140) || socket.closes.length);
	assert.deepEqual(socket.closes, []);
	if (mode === 'send') {
		const api = { transaction, replicationConfirmation, setResidencyPlacementGuard };
		// Resolve the exact binding used by the compiled Pro core.
		const native = req('@harperfast/rocksdb-js');
		api.Transaction = native.Transaction;
		api.constants = native.constants;
		const result = await helper.abortMove(Records, api);
		socket.emit(
			'message',
			encode([
				129,
				[{ name: server.hostname, startTime: result.committed[0].txnLogKey, tables: [], replicateByDefault: true }],
				[],
			])
		);
		await Records.put('barrier', { id: 'barrier', region: 0, zone: 0, body: 'after abort' });
		await until(() => socket.closes.length || records(socket, Records).some((e) => e.recordId === 'barrier'));
		result.closes = socket.closes;
		result.sent = records(socket, Records);
		result.frames = socket.sent.map((f) => f.toString('base64'));
		result.messages = socket.sent.filter((f) => f[0] > 127).map((f) => decode(f));
		writeFileSync(output, JSON.stringify(result, null, 2));
		assert.deepEqual(socket.closes, []);
	} else {
		const source = JSON.parse(readFileSync(sourceFile, 'utf8'));
		// Observe completed received commits via the table's real primary after each inbound frame drains.
		const seed = source.committed[0];
		const nodeId = req('#src/core/resources/nodeIdMapping').getIdOfRemoteNode('abort-source', Records.auditStore);
		const context = { source: {}, sourceApply: true, timestamp: seed.txnLogKey };
		await transaction(context, async () => {
			const row = await Records.getResource('retry-abort', context);
			row._writeUpdate('retry-abort', seed.value, true, {
				nodeId,
				version: seed.version,
				isCopyApply: true,
				residencySlot: 0,
			});
			row.save();
		});
		const frames = source.frames.map((f) => Buffer.from(f, 'base64'));
		for (const frame of frames) {
			if (frame[0] > 127 && [140, 129, 142].includes(decode(frame)[0])) continue;
			socket.emit('message', frame);
		}
		await until(() => socket.closes.length || Records.primaryStore.getEntry('barrier'));
		await until(() => getOutstandingCommits().count === 0);
		await req('#src/core/resources/databases').flushDatabases();
		const result = {
			closes: socket.closes,
			primary: helper.snapshot(Records),
			audit: helper.audit(Records, { log: undefined, readUncommitted: true }),
			responses: socket.sent.filter((f) => f[0] > 127).map((f) => decode(f)),
		};
		writeFileSync(output, JSON.stringify(result, null, 2));
		assert.deepEqual(socket.closes, []);
	}
	socket.close();
	process.exit(0);
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
