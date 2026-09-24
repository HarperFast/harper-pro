import { expect } from 'chai';
import {
	appendFileSync,
	cpSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import {
	compactLogFile,
	decodeEntry,
	repairDatabase,
	repairHarperRoot,
	restoreRepair,
	RepairRefusedError,
} from '#src/replication/repairDeleteEchoRuns';
import { RocksTransactionLogStore } from '#src/core/resources/RocksTransactionLogStore';

// Required, not imported: the ESM entry would evaluate a second copy of the package beside the one the
// data layer already loaded through CJS.
const { RocksDatabase, validateTransactionLogStore } = createRequire(import.meta.url)('@harperfast/rocksdb-js');

const TABLE_ID = 7;
const NODE_ID = 3;
// after every file header written during the run, as real entries are
const T = Date.now() + 60_000;
const deleteOf = (id, extra) => ({
	type: 'delete',
	tableId: TABLE_ID,
	recordId: id,
	version: T,
	nodeId: NODE_ID,
	user: 'admin',
	structureVersion: 0,
	...extra,
});
const putOf = (id, version, extra) => ({
	type: 'put',
	tableId: TABLE_ID,
	recordId: id,
	version,
	nodeId: NODE_ID,
	user: 'admin',
	encodedRecord: Buffer.from([0x81, 0xa1, 0x61, 0x01]),
	structureVersion: 0,
	...extra,
});
// the first application links the record's real previous version; every echoed copy links the delete itself
const firstDelete = (id, extra) => deleteOf(id, { previousVersion: T - 5000, ...extra });
const echoedDelete = (id, extra) => deleteOf(id, { previousVersion: T, ...extra });

async function rejection(promise) {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error('expected a rejection');
}

/** A separate process holding the database open, as a running Harper would. */
async function holdInChild(databasePath) {
	const child = spawn(
		process.execPath,
		[
			'-e',
			`const { RocksDatabase } = require('@harperfast/rocksdb-js');
			const db = new RocksDatabase(${JSON.stringify(databasePath)});
			db.open();
			console.log('open');
			process.stdin.on('end', () => { db.close(); process.exit(0); });
			process.stdin.resume();`,
		],
		{ stdio: ['pipe', 'pipe', 'inherit'] }
	);
	const [chunk] = await once(child.stdout, 'data');
	expect(String(chunk)).to.match(/open/);
	return async () => {
		child.stdin.end();
		await once(child, 'exit');
	};
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const logDir = (databasePath) => join(databasePath, 'transaction_logs', 'local');

function entryOffsets(path) {
	const bytes = readFileSync(path);
	const offsets = [];
	for (let offset = 13; offset < bytes.length; offset += 13 + bytes.readUInt32BE(offset + 8)) offsets.push(offset);
	return offsets;
}

function snapshot(databasePath) {
	const dir = logDir(databasePath);
	return Object.fromEntries(readdirSync(dir).map((name) => [name, sha256(join(dir, name))]));
}

async function withDatabase(databasePath, callback) {
	const db = new RocksDatabase(databasePath);
	db.open();
	try {
		return await callback(db, new RocksTransactionLogStore(db));
	} finally {
		db.close();
	}
}

/** Writes each transaction `[timestamp, records]` through core's own audit-entry writer. */
function writeTransactions(databasePath, transactions) {
	return withDatabase(databasePath, async (db, store) => {
		for (const [timestamp, records] of transactions) {
			await db.transaction((transaction) => {
				transaction.setTimestamp(timestamp);
				for (const record of records) store.put(0, { ...record }, { transaction });
			});
		}
	});
}

function readBack(databasePath) {
	return withDatabase(databasePath, (db, store) =>
		Array.from(store.getRange({ start: 0, log: 'local' }), (record) => ({
			type: record.type,
			id: record.recordId,
			timestamp: record.txnLogKey,
			endTxn: record.endTxn,
			previousVersion: record.previousVersion,
		}))
	);
}

describe('repairDeleteEchoRuns (harper-pro#826)', function () {
	this.timeout(60000);
	let root;
	let counter = 0;
	const newDatabase = () => {
		const databasePath = join(root, `db${counter++}`);
		mkdirSync(databasePath);
		return databasePath;
	};

	before(() => {
		root = mkdtempSync(join(tmpdir(), 'repair-delete-echo-runs-'));
	});

	after(() => {
		rmSync(root, { recursive: true, force: true });
	});

	describe('decodeEntry', () => {
		it("reads the record key and type from core's entry layout, past every prelude field", async () => {
			const databasePath = newDatabase();
			const longId = 'k'.repeat(300);
			await writeTransactions(databasePath, [
				[T, [firstDelete('a'), putOf('a', T), deleteOf(longId, { previousResidencyId: 9 })]],
				[T + 1, [deleteOf('b', { extendedType: 0x1000, expiresAt: T + 9000 })]],
			]);
			const bytes = readFileSync(join(logDir(databasePath), '1.txnlog'));
			const decoded = entryOffsets(join(logDir(databasePath), '1.txnlog')).map((offset) =>
				decodeEntry(bytes.subarray(offset + 13, offset + 13 + bytes.readUInt32BE(offset + 8)))
			);
			expect(decoded.map((entry) => entry.isDelete)).to.deep.equal([true, false, true, true]);
			expect(decoded[0].recordKey).to.equal(decoded[1].recordKey);
			expect(decoded[2].recordKey).to.have.length.above(300);
			expect(new Set(decoded.map((entry) => entry.recordKey)).size).to.equal(3);
		});

		it('keeps table and record ids apart in the key', () => {
			const entry = (tableId, id) =>
				Buffer.from([0, 0, 0, 0, 2, NODE_ID, tableId, id.length, ...Buffer.from(id), ...Buffer.alloc(9)]);
			expect(decodeEntry(entry(1, '23')).recordKey).to.not.equal(decodeEntry(entry(12, '3')).recordKey);
		});

		it('declines entries too short for their fields', () => {
			expect(decodeEntry(Buffer.from([0, 0, 0, 0, 2, 3, 7, 40, 1, 2]))).to.equal(undefined);
			expect(decodeEntry(Buffer.from([0, 0, 0]))).to.equal(undefined);
		});
	});

	describe('repair', () => {
		it('drops echoed copies of a single-record run, across batches and within one', async () => {
			const databasePath = newDatabase();
			const copies = Array.from({ length: 50 }, () => echoedDelete('z'));
			await writeTransactions(databasePath, [
				[T, [firstDelete('z')]],
				[T, [echoedDelete('z')]],
				[T, copies],
				[T, [echoedDelete('z')]],
				[T + 1, [putOf('m', T + 1)]],
			]);
			const report = await repairDatabase(databasePath, { apply: true });
			expect(report.applied).to.equal(true);
			expect(report.logs[0].dropped).to.equal(52);
			expect(report.logs[0].largestSpanAfter).to.be.below(report.logs[0].largestSpanBefore / 20);
			expect(await readBack(databasePath)).to.deep.equal([
				{ type: 'delete', id: 'z', timestamp: T, endTxn: true, previousVersion: T - 5000 },
				{ type: 'put', id: 'm', timestamp: T + 1, endTxn: true, previousVersion: undefined },
			]);
		});

		it('drops interleaved copies of a multi-record delete', async () => {
			const databasePath = newDatabase();
			const rounds = Array.from({ length: 40 }, () => [echoedDelete('x'), echoedDelete('y')]).flat();
			await writeTransactions(databasePath, [
				[T, [firstDelete('x'), firstDelete('y')]],
				[T, rounds],
			]);
			await repairDatabase(databasePath, { apply: true });
			expect((await readBack(databasePath)).map(({ id, endTxn }) => [id, endTxn])).to.deep.equal([
				['x', false],
				['y', true],
			]);
		});

		it('keeps a delete that follows another write to the same record, and deletes under other timestamps', async () => {
			const databasePath = newDatabase();
			await writeTransactions(databasePath, [
				[T, [deleteOf('k'), putOf('k', T), deleteOf('k')]],
				[T + 1, [deleteOf('q')]],
				[T + 2, [putOf('other', T + 2)]],
				[T + 1, [deleteOf('q')]],
			]);
			const before = snapshot(databasePath);
			const report = await repairDatabase(databasePath, { apply: true });
			expect(report.logs[0].dropped).to.equal(0);
			expect(report.backupDir).to.equal(undefined);
			expect(snapshot(databasePath)).to.deep.equal(before);
		});

		it('moves the last flag of a dropped copy to the last kept entry of its transaction', async () => {
			const databasePath = newDatabase();
			await writeTransactions(databasePath, [[T, [deleteOf('z'), putOf('a', T), deleteOf('z')]]]);
			await repairDatabase(databasePath, { apply: true });
			expect((await readBack(databasePath)).map(({ id, endTxn }) => [id, endTxn])).to.deep.equal([
				['z', false],
				['a', true],
			]);
		});

		it('remaps the flushed position in txn.state so replay starts at the same entry', async () => {
			const databasePath = newDatabase();
			await writeTransactions(databasePath, [
				[T, [firstDelete('z')]],
				[T, Array.from({ length: 20 }, () => echoedDelete('z'))],
				[T + 1, [putOf('m', T + 1)]],
			]);
			const file = join(logDir(databasePath), '1.txnlog');
			const flushed = entryOffsets(file).at(-1);
			const state = Buffer.alloc(8);
			state.writeUInt32LE(flushed, 0);
			state.writeUInt32LE(1, 4);
			writeFileSync(join(logDir(databasePath), 'txn.state'), state);
			await repairDatabase(databasePath, { apply: true });
			const remapped = readFileSync(join(logDir(databasePath), 'txn.state'));
			expect(remapped.readUInt32LE(0)).to.equal(entryOffsets(file).at(-1));
			expect(remapped.readUInt32LE(4)).to.equal(1);
			const replayed = await withDatabase(databasePath, (db, store) =>
				Array.from(store.getRange({ startFromLastFlushed: true, readUncommitted: true }), (record) => record.recordId)
			);
			expect(replayed).to.deep.equal(['m']);
		});

		it('starts a new tail file when it rewrites the newest one, so no stale coverage position matches', async () => {
			const databasePath = newDatabase();
			// the file's header keeps the timestamp it was created at, older than the run
			await writeTransactions(databasePath, [
				[T - 10, [putOf('p', T - 10)]],
				[T, [firstDelete('z')]],
				[T, [echoedDelete('z')]],
			]);
			const report = await repairDatabase(databasePath, { apply: true });
			expect(report.logs[0].createdTailFile).to.equal('2.txnlog');
			expect(statSync(join(logDir(databasePath), '2.txnlog')).size).to.equal(13);
			await withDatabase(databasePath, async (db, store) => {
				const log = db.useLog('local');
				// a cursor between the header and the run must still start in the file that holds the run
				expect(Array.from(log.query({ start: T - 5 }))).to.have.length(1);
				expect(Array.from(log.query({ start: T + 1 }))).to.have.length(0);
				const { lastCommittedPosition, nextLogPosition } = log.getStats();
				expect(lastCommittedPosition).to.not.deep.equal(nextLogPosition);
				await db.transaction((transaction) => store.put(0, putOf('next', T + 1), { transaction }));
				expect(log.getStats().lastCommittedPosition.sequence).to.equal(2);
			});
			expect((await readBack(databasePath)).map(({ id }) => id)).to.deep.equal(['p', 'z', 'next']);
		});

		it('handles a transaction split across files by an older writer', async () => {
			const databasePath = newDatabase();
			await writeTransactions(databasePath, [[T, [firstDelete('z'), echoedDelete('z')]]]);
			const dir = logDir(databasePath);
			const bytes = readFileSync(join(dir, '1.txnlog'));
			const [first, second] = entryOffsets(join(dir, '1.txnlog'));
			const header = bytes.subarray(0, 13);
			const open = Buffer.from(bytes.subarray(second, bytes.length));
			open[12] = 0;
			const closing = bytes.subarray(second, bytes.length);
			// file 1: [z, z'] with no last flag; file 2: [z', z'(last)]
			writeFileSync(join(dir, '1.txnlog'), Buffer.concat([header, bytes.subarray(first, second), open]));
			writeFileSync(join(dir, '2.txnlog'), Buffer.concat([header, open, closing]));
			rmSync(join(dir, 'txn.state'), { force: true });
			const report = await repairDatabase(databasePath, { apply: true });
			expect(report.logs[0].dropped).to.equal(2);
			expect((await readBack(databasePath)).map(({ id, endTxn }) => [id, endTxn])).to.deep.equal([
				['z', false],
				['z', true],
			]);
			expect((await validateTransactionLogStore(dir, { strict: true })).valid).to.equal(true);
		});

		it('drops copies in a later file that continue a run the previous file closed', async () => {
			const databasePath = newDatabase();
			await writeTransactions(databasePath, [
				[T, [firstDelete('z')]],
				[T, [echoedDelete('z')]],
			]);
			const dir = logDir(databasePath);
			const bytes = readFileSync(join(dir, '1.txnlog'));
			const [first, second] = entryOffsets(join(dir, '1.txnlog'));
			writeFileSync(join(dir, '1.txnlog'), bytes.subarray(0, second));
			writeFileSync(join(dir, '2.txnlog'), Buffer.concat([bytes.subarray(0, 13), bytes.subarray(second)]));
			rmSync(join(dir, 'txn.state'), { force: true });
			const report = await repairDatabase(databasePath, { apply: true });
			expect(report.logs[0].dropped).to.equal(1);
			expect(report.logs[0].largestSpanBefore).to.equal(bytes.length - 13);
			expect(report.logs[0].largestSpanAfter).to.equal(second - first);
			expect((await readBack(databasePath)).map(({ id }) => id)).to.deep.equal(['z']);
		});

		it('repairs an older file beside a newest one it refuses for a torn tail', async () => {
			const databasePath = newDatabase();
			await writeTransactions(databasePath, [
				[T, [firstDelete('z')]],
				[T, [echoedDelete('z')]],
			]);
			const dir = logDir(databasePath);
			const header = readFileSync(join(dir, '1.txnlog')).subarray(0, 13);
			writeFileSync(join(dir, '2.txnlog'), Buffer.concat([header, Buffer.from([1, 2, 3])]));
			rmSync(join(dir, 'txn.state'), { force: true });
			const report = await repairDatabase(databasePath, { apply: true });
			expect(report.applied).to.equal(true);
			expect(report.logs[0].rewritten).to.deep.equal(['1.txnlog']);
			expect(report.logs[0].refused.map(({ file }) => file)).to.deep.equal(['2.txnlog']);
		});

		it('refuses a symlinked database directory rather than skipping it', async () => {
			const harperRootPath = mkdtempSync(join(root, 'harper-'));
			mkdirSync(join(harperRootPath, 'database'));
			symlinkSync(await (async () => newDatabase())(), join(harperRootPath, 'database', 'data'));
			const [report] = await repairHarperRoot(harperRootPath);
			expect(report.refused).to.match(/symbolic link/);
		});

		it('refuses a file whose run needs more state than the budget to compare', async () => {
			const databasePath = newDatabase();
			await writeTransactions(databasePath, [
				[T, [firstDelete('x'), firstDelete('y')]],
				[T, [echoedDelete('x'), echoedDelete('y')]],
			]);
			const report = await repairDatabase(databasePath, { maxSpanBytes: 100 });
			expect(report.logs[0].refused.map(({ reason }) => reason).join()).to.match(/more than 100 bytes to compare/);
			expect(report.logs[0].dropped).to.equal(0);
		});

		it('is a no-op on a second run', async () => {
			const databasePath = newDatabase();
			await writeTransactions(databasePath, [
				[T, [firstDelete('z')]],
				[T, [echoedDelete('z')]],
			]);
			await repairDatabase(databasePath, { apply: true });
			const repaired = snapshot(databasePath);
			const report = await repairDatabase(databasePath, { apply: true });
			expect(report.logs[0].dropped).to.equal(0);
			expect(report.backupDir).to.equal(undefined);
			expect(snapshot(databasePath)).to.deep.equal(repaired);
		});

		it('reports without changing anything unless applied', async () => {
			const databasePath = newDatabase();
			await writeTransactions(databasePath, [
				[T, [firstDelete('z')]],
				[T, [echoedDelete('z')]],
			]);
			const before = snapshot(databasePath);
			const report = await repairDatabase(databasePath);
			expect(report.logs[0].dropped).to.equal(1);
			expect(report.applied).to.equal(false);
			expect(snapshot(databasePath)).to.deep.equal(before);
			expect(readdirSync(databasePath).filter((name) => name.startsWith('transaction_logs.repair-'))).to.deep.equal([]);
		});
	});

	describe('refusals', () => {
		async function runDatabase() {
			const databasePath = newDatabase();
			await writeTransactions(databasePath, [
				[T, [firstDelete('z')]],
				[T, [echoedDelete('z')]],
				[T + 1, [putOf('m', T + 1)]],
			]);
			return databasePath;
		}

		async function expectFileRefused(databasePath, pattern) {
			const before = snapshot(databasePath);
			const report = await repairDatabase(databasePath, { apply: true });
			expect(report.logs[0].refused.map(({ reason }) => reason).join()).to.match(pattern);
			expect(report.logs[0].rewritten).to.deep.equal([]);
			expect(snapshot(databasePath)).to.deep.equal(before);
		}

		it('a file with a torn tail', async () => {
			const databasePath = await runDatabase();
			appendFileSync(join(logDir(databasePath), '1.txnlog'), Buffer.from([1, 2, 3, 4, 5]));
			await expectFileRefused(databasePath, /strict validation/);
		});

		it('a file with a retired append boundary', async () => {
			const databasePath = await runDatabase();
			const marker = join(databasePath, 'transaction_logs', '.append-boundaries', 'local', '1.txnlog.boundary');
			const bytes = Buffer.alloc(12);
			const boundary = statSync(join(logDir(databasePath), '1.txnlog')).size;
			bytes.writeUInt32BE(0x52455449, 0);
			bytes.writeUInt32BE(boundary, 4);
			bytes.writeUInt32BE(~boundary >>> 0, 8);
			writeFileSync(marker, bytes);
			await expectFileRefused(databasePath, /append boundary/);
		});

		it('a flushed position that is not an entry boundary', async () => {
			const databasePath = await runDatabase();
			const state = Buffer.alloc(8);
			state.writeUInt32LE(entryOffsets(join(logDir(databasePath), '1.txnlog'))[1] + 3, 0);
			state.writeUInt32LE(1, 4);
			writeFileSync(join(logDir(databasePath), 'txn.state'), state);
			await expectFileRefused(databasePath, /not an entry boundary|strict validation/);
		});

		it('a newest file whose last transaction is unclosed', async () => {
			const databasePath = await runDatabase();
			const file = join(logDir(databasePath), '1.txnlog');
			const bytes = readFileSync(file);
			bytes[entryOffsets(file).at(-1) + 12] = 0;
			writeFileSync(file, bytes);
			await expectFileRefused(databasePath, /unclosed transaction/);
		});

		it('a store holding a file it does not recognize', async () => {
			const databasePath = await runDatabase();
			writeFileSync(join(logDir(databasePath), 'notes.txt'), 'x');
			const report = await repairDatabase(databasePath, { apply: true });
			expect(report.refused).to.match(/unrecognized file/);
		});

		it('a log file with another hard link', async () => {
			const databasePath = await runDatabase();
			linkSync(join(logDir(databasePath), '1.txnlog'), join(root, `link${counter++}`));
			const report = await repairDatabase(databasePath, { apply: true });
			expect(report.refused).to.match(/hard links/);
		});

		it('a database another process has open, by its RocksDB lock', async () => {
			const databasePath = await runDatabase();
			const before = snapshot(databasePath);
			const release = await holdInChild(databasePath);
			try {
				expect((await rejection(repairDatabase(databasePath, { apply: true }))).message).to.match(
					/could not be opened exclusively/
				);
			} finally {
				await release();
			}
			expect(snapshot(databasePath)).to.deep.equal(before);
		});

		it('a store Harper wrote to while it was being repaired', async () => {
			const databasePath = await runDatabase();
			let error;
			try {
				await repairDatabase(databasePath, {
					apply: true,
					afterStep: (step) => {
						if (step === 'preparing') appendFileSync(join(logDir(databasePath), '1.txnlog'), Buffer.alloc(1));
					},
				});
			} catch (caught) {
				error = caught;
			}
			expect(error?.message).to.match(/No changes were made/);
			expect(readdirSync(databasePath).filter((name) => name.startsWith('transaction_logs.repair-'))).to.deep.equal([]);
		});
	});

	describe('crash safety and restore', () => {
		async function pristine() {
			const databasePath = newDatabase();
			await writeTransactions(databasePath, [
				[T, [firstDelete('z')]],
				[T, Array.from({ length: 10 }, () => echoedDelete('z'))],
				[T + 1, [putOf('m', T + 1)]],
			]);
			const state = Buffer.alloc(8);
			state.writeUInt32LE(entryOffsets(join(logDir(databasePath), '1.txnlog')).at(-1), 0);
			state.writeUInt32LE(1, 4);
			writeFileSync(join(logDir(databasePath), 'txn.state'), state);
			return databasePath;
		}

		const backupOf = (databasePath) =>
			join(
				databasePath,
				readdirSync(databasePath).find((name) => name.startsWith('transaction_logs.repair-'))
			);

		it('leaves a readable store at every step and restores the exact originals', async () => {
			const template = await pristine();
			const steps = [];
			const probe = join(root, `probe${counter++}`);
			cpSync(template, probe, { recursive: true });
			await repairDatabase(probe, { apply: true, afterStep: (step) => steps.push(step) });
			expect(steps).to.include.members(['preparing', 'staged', 'local: replaced 1.txnlog', 'applied']);
			for (const crashAt of steps.filter((step) => step !== 'preparing')) {
				const databasePath = join(root, `crash${counter++}`);
				cpSync(template, databasePath, { recursive: true });
				const original = snapshot(databasePath);
				let crashed = false;
				try {
					await repairDatabase(databasePath, {
						apply: true,
						afterStep: (step) => {
							if (step === crashAt) throw new Error(`crash after ${step}`);
						},
					});
				} catch (error) {
					crashed = /crash after/.test(error.message) && /--restore/.test(error.message);
				}
				expect(crashed, crashAt).to.equal(true);
				const validation = await validateTransactionLogStore(logDir(databasePath), { strict: true });
				expect(validation.valid, `${crashAt}: ${JSON.stringify(validation)}`).to.equal(true);
				expect(new Set((await readBack(databasePath)).map(({ id }) => id)), crashAt).to.deep.equal(new Set(['z', 'm']));
				const replayed = await withDatabase(databasePath, (db, store) =>
					Array.from(store.getRange({ startFromLastFlushed: true, readUncommitted: true }), ({ type }) => type)
				);
				expect(replayed, crashAt).to.not.include(undefined);
				expect(replayed, crashAt).to.include('put');
				const again = await repairDatabase(databasePath, { apply: true });
				expect(again.refused, crashAt).to.match(/did not finish/);
				await restoreRepair(backupOf(databasePath));
				expect(snapshot(databasePath), crashAt).to.deep.equal(original);
				const redo = await repairDatabase(databasePath, { apply: true });
				expect(redo.applied, crashAt).to.equal(true);
			}
		});

		it('removes a backup its own repair left before changing anything, and refuses one it did not record', async () => {
			const databasePath = await pristine();
			const stale = join(databasePath, 'transaction_logs.repair-stale');
			mkdirSync(join(stale, 'local'), { recursive: true });
			linkSync(join(logDir(databasePath), '1.txnlog'), join(stale, 'local', '1.txnlog'));
			const refused = await repairDatabase(databasePath, { apply: true });
			expect(refused.refused).to.match(/not a repair this tool recorded/);
			writeFileSync(join(stale, 'manifest.json'), JSON.stringify({ format: 1, state: 'preparing', logs: [] }));
			const report = await repairDatabase(databasePath, { apply: true });
			expect(report.removedBackups).to.deep.equal([stale]);
			expect(report.applied).to.equal(true);
		});

		it('removes its staging when interrupted after the preparing manifest', async () => {
			const databasePath = await pristine();
			try {
				await repairDatabase(databasePath, {
					apply: true,
					afterStep: (step) => {
						if (step === 'preparing') throw new Error('crash');
					},
				});
			} catch {}
			const report = await repairDatabase(databasePath, { apply: true });
			expect(report.removedBackups).to.have.length(1);
			expect(report.applied).to.equal(true);
		});

		it('detects a process writing to a replaced file during the repair', async () => {
			const databasePath = await pristine();
			let error;
			try {
				await repairDatabase(databasePath, {
					apply: true,
					afterStep: (step) => {
						if (step === 'local: replaced 1.txnlog')
							appendFileSync(join(backupOf(databasePath), 'local', '1.txnlog'), Buffer.alloc(13));
					},
				});
			} catch (caught) {
				error = caught;
			}
			expect(error?.message).to.match(/written to during the repair/);
		});

		it('refuses a manifest naming a path outside the database', async () => {
			const databasePath = await pristine();
			const backupDir = join(databasePath, 'transaction_logs.repair-crafted');
			mkdirSync(backupDir);
			writeFileSync(
				join(backupDir, 'manifest.json'),
				JSON.stringify({ format: 1, state: 'applied', logs: [{ name: '../../x', replaced: [], created: [] }] })
			);
			expect(await rejection(restoreRepair(backupDir))).to.be.instanceOf(RepairRefusedError);
		});

		it('names both ways out of an unfinished repair', async () => {
			const databasePath = await pristine();
			try {
				await repairDatabase(databasePath, {
					apply: true,
					afterStep: (step) => {
						if (step === 'staged') throw new Error('crash');
					},
				});
			} catch {}
			const report = await repairDatabase(databasePath, { apply: true });
			expect(report.refused).to.match(/--restore .*\n.*by deleting/s);
		});

		it('restores into the copy it was run from when the root has been copied', async () => {
			const databasePath = await pristine();
			const original = sha256(join(logDir(databasePath), '1.txnlog'));
			await repairDatabase(databasePath, { apply: true });
			const repaired = snapshot(databasePath);
			const copy = join(root, `copy${counter++}`);
			cpSync(databasePath, copy, { recursive: true });
			await restoreRepair(backupOf(copy));
			expect(sha256(join(logDir(copy), '1.txnlog'))).to.equal(original);
			expect(snapshot(databasePath)).to.deep.equal(repaired);
		});

		it('restores a completed repair', async () => {
			const databasePath = await pristine();
			const original = snapshot(databasePath);
			await repairDatabase(databasePath, { apply: true });
			expect(existsSync(join(logDir(databasePath), '2.txnlog'))).to.equal(true);
			const backupDir = backupOf(databasePath);
			await restoreRepair(backupDir);
			expect(snapshot(databasePath)).to.deep.equal(original);
			expect(existsSync(backupDir)).to.equal(false);
		});

		it('refuses to restore once Harper has written to the repaired store', async () => {
			const databasePath = await pristine();
			await repairDatabase(databasePath, { apply: true });
			await writeTransactions(databasePath, [[T + 2, [putOf('later', T + 2)]]]);
			expect((await rejection(restoreRepair(backupOf(databasePath)))).message).to.match(/written to since/);
		});
	});

	describe('CLI', () => {
		const cli = resolve(import.meta.dirname, '..', '..', 'dist', 'bin', 'repairDeleteEchoRuns.js');
		async function harperRoot() {
			const harperRootPath = mkdtempSync(join(root, 'harper-'));
			const databasePath = join(harperRootPath, 'database', 'data');
			mkdirSync(databasePath, { recursive: true });
			await writeTransactions(databasePath, [
				[T, [firstDelete('z')]],
				[T, [echoedDelete('z')]],
			]);
			return { harperRootPath, databasePath };
		}
		const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

		it('reports, repairs and exits 0', async () => {
			const { harperRootPath } = await harperRoot();
			const dry = run(harperRootPath);
			expect(dry.status, dry.stderr).to.equal(0);
			expect(dry.stdout).to.match(/log local: .* would drop 1 echoed deletes/);
			const applied = run(harperRootPath, '--apply');
			expect(applied.status, applied.stderr).to.equal(0);
			expect(applied.stdout).to.match(/log local: .* dropped 1 echoed deletes/);
		});

		it('exits non-zero when any file is refused', async () => {
			const { harperRootPath, databasePath } = await harperRoot();
			appendFileSync(join(logDir(databasePath), '1.txnlog'), Buffer.from([1, 2, 3]));
			const result = run(harperRootPath, '--apply');
			expect(result.status).to.equal(1);
			expect(result.stdout).to.match(/not repaired 1\.txnlog/);
		});

		it('exits 2 on a usage error', () => {
			expect(run().status).to.equal(2);
		});
	});

	it('compactLogFile reports the same decisions in a dry run as when writing', async () => {
		const databasePath = newDatabase();
		await writeTransactions(databasePath, [
			[T, [firstDelete('x'), firstDelete('y')]],
			[T, [echoedDelete('x'), echoedDelete('y'), echoedDelete('x')]],
		]);
		const file = join(logDir(databasePath), '1.txnlog');
		const dry = compactLogFile(file);
		expect(dry.dropped).to.equal(3);
		expect(dry.kept).to.equal(2);
		expect(dry.inputSha256).to.equal(sha256(file));
		expect(() => compactLogFile(file, { maxEntryBytes: 10 })).to.throw(RepairRefusedError, /-byte entry/);
	});
});
