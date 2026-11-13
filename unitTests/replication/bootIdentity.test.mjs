/**
 * The facts own-origin recovery's start gate reads: this boot's identity and the transaction-log sync failure marker.
 */
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	clearSyncFailureMarker,
	onRocksWarning,
	readBootId,
	readSyncFailureMarker,
	recordSyncFailure,
	validBootId,
} from '#src/replication/bootIdentity';

const MARKER = 'own-origin-recovery-log-sync-failed';
const SYNC_FAILURE_WARNING =
	'Transaction log segment /data/database/data/transaction_logs/local/3.txnlog could not be synced before a database flush (Input/output error).';

function withBootOverride(value, run) {
	const saved = process.env.HARPER_TEST_BOOT_ID;
	if (value === undefined) delete process.env.HARPER_TEST_BOOT_ID;
	else process.env.HARPER_TEST_BOOT_ID = value;
	try {
		return run();
	} finally {
		if (saved === undefined) delete process.env.HARPER_TEST_BOOT_ID;
		else process.env.HARPER_TEST_BOOT_ID = saved;
	}
}

describe('readBootId', () => {
	it("reads the kernel's boot_id on Linux", function () {
		if (process.platform !== 'linux') return this.skip();
		withBootOverride(undefined, () => {
			const expected = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
			assert.strictEqual(readBootId('linux'), expected);
		});
	});

	it('has no boot identity on a platform without an authoritative one, so every start recovers', () => {
		withBootOverride(undefined, () => assert.strictEqual(readBootId('win32'), undefined));
	});

	it('takes the test override, and treats a malformed one as unknown', () => {
		withBootOverride('boot-1', () => assert.strictEqual(readBootId('linux'), 'boot-1'));
		withBootOverride('', () => assert.strictEqual(readBootId('linux'), undefined));
		withBootOverride('not a boot id', () => assert.strictEqual(readBootId('linux'), undefined));
	});

	it('accepts only a short printable token', () => {
		assert.strictEqual(validBootId('0f3c1b2a-9d8e-4f00-a1b2-c3d4e5f60718\n'), '0f3c1b2a-9d8e-4f00-a1b2-c3d4e5f60718');
		assert.strictEqual(validBootId('x'.repeat(129)), undefined);
		assert.strictEqual(validBootId(42), undefined);
	});
});

describe('sync failure marker', () => {
	let root;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'harper-boot-identity-'));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it('reads as absent only when the file does not exist', () => {
		assert.deepStrictEqual(readSyncFailureMarker(root), { present: false });
		mkdirSync(join(root, MARKER));
		assert.deepStrictEqual(readSyncFailureMarker(root), { present: true });
	});

	it('a rocksdb-js sync failure warning records it; other warnings do not', () => {
		onRocksWarning(root, 'Transaction log segment 3.txnlog was purged');
		assert.strictEqual(existsSync(join(root, MARKER)), false);
		onRocksWarning(root, SYNC_FAILURE_WARNING);
		const marker = readSyncFailureMarker(root);
		assert.strictEqual(marker.present, true);
		assert.ok(marker.token);
	});

	it('is cleared only by the token that was read, so a failure recorded during startup survives', () => {
		recordSyncFailure(root);
		const atStartup = readSyncFailureMarker(root);
		recordSyncFailure(root);
		clearSyncFailureMarker(root, atStartup.token);
		const later = readSyncFailureMarker(root);
		assert.strictEqual(later.present, true);
		assert.notStrictEqual(later.token, atStartup.token);
		clearSyncFailureMarker(root, later.token);
		assert.deepStrictEqual(readSyncFailureMarker(root), { present: false });
	});

	it('never throws when the marker cannot be written', () => {
		assert.doesNotThrow(() => recordSyncFailure(join(root, 'missing', 'dir')));
		assert.doesNotThrow(() => onRocksWarning(join(root, 'missing', 'dir'), SYNC_FAILURE_WARNING));
		assert.doesNotThrow(() => clearSyncFailureMarker(join(root, 'missing'), 'token'));
	});
});
