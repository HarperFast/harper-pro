// replication/DESIGN.md item 20. Imports only `node:` built-ins and rocksdb-js: Harper's runtime modules
// initialize configuration, logging and storage when loaded.
import {
	closeSync,
	constants as fsConstants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	realpathSync,
	rmSync,
	statSync,
	writeSync,
	existsSync,
	type Stats,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { endianness, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { constants as rocksConstants, RocksDatabase, validateTransactionLogStore } from '@harperfast/rocksdb-js';

const FILE_HEADER_SIZE = 13;
const FILE_TIMESTAMP_OFFSET = 5;
const ENTRY_HEADER_SIZE = 13;
const ENTRY_FLAGS_OFFSET = 12;
const LAST_FLAG = 1;
const FORMAT_VERSION = 1;
const BOUNDARY_MARKER_TOKEN = 0x52455449;
const BOUNDARY_MARKER_SIZE = 12;
const BOUNDARY_DIR = '.append-boundaries';
const TXN_STATE = 'txn.state';
const TXN_STATE_SIZE = 8;
// RocksTransactionLogStore's prelude flags, and the delete action of core's audit entry
const HAS_PREVIOUS_RESIDENCY_ID = 0x40000000;
const HAS_PREVIOUS_VERSION = 0x20000000;
const PREVIOUS_VERSION_FIRST_BYTE = 0x42;
const DELETE_ACTION = 2;
/** A file whose one-timestamp run needs more state than this, or holds a larger entry, is refused. */
export const MAX_SPAN_BYTES = 256 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const SPAN_ENTRY_OVERHEAD = 64;
const BACKUP_PREFIX = 'transaction_logs.repair-';
const MANIFEST = 'manifest.json';
const LOG_NAME_PATTERN = /^(?!\.\.?$)[^/\\\0]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const LOG_FILE_PATTERN = /^([1-9]\d*)\.txnlog$/;
const BOUNDARY_FILE_PATTERN = /^([1-9]\d*)\.txnlog\.boundary$/;

export class RepairRefusedError extends Error {}

export interface LogPosition {
	offset: number;
	sequence: number;
}

export interface FileScan {
	entries: number;
	kept: number;
	dropped: number;
	bytesIn: number;
	bytesOut: number;
	/** Largest run of one timestamp, in bytes: what the sender would frame as one message. */
	largestSpanIn: number;
	largestSpanOut: number;
	/** The last entry does not close its transaction. */
	endsUnclosed: boolean;
	/** The larger of the file header's timestamp and every entry's. */
	latestTimestamp: number;
	trailing: SpanCarry;
	/** Where `flushedOffset` lands in the output, when it is an entry boundary of the input. */
	mappedFlushedOffset?: number;
	inputSha256: string;
	outputSha256: string;
}

export interface SpanCarry {
	timestamp: number;
	records: Map<string, Buffer | null>;
	bytes: number;
	sizeIn: number;
	sizeOut: number;
}

export interface CompactOptions {
	output?: number;
	flushedOffset?: number;
	/** The previous file's trailing run, which the sender frames together with this file's leading one. */
	carry?: SpanCarry;
	maxSpanBytes?: number;
	maxEntryBytes?: number;
}

interface DecodedEntry {
	isDelete: boolean;
	recordKey: string;
	replicatedStart: number;
}

function readVarint(data: Buffer, cursor: { position: number }): number | undefined {
	const position = cursor.position;
	if (position >= data.length) return;
	const first = data[position];
	if (first < 0x80) {
		cursor.position = position + 1;
		return first;
	}
	if (first < 0xc0) {
		if (position + 2 > data.length) return;
		cursor.position = position + 2;
		return data.readUInt16BE(position) & 0x7fff;
	}
	if (first < 0xff) {
		if (position + 4 > data.length) return;
		cursor.position = position + 4;
		return data.readUInt32BE(position) & 0x3fffffff;
	}
	if (position + 5 > data.length) return;
	cursor.position = position + 5;
	return data.readUInt32BE(position + 1);
}

/**
 * Mirrors the field layout RocksTransactionLogStore.getRange and core's readAuditEntry read; returns
 * undefined for anything that does not decode, which the caller keeps verbatim.
 */
const cursor = { position: 0 };

export function decodeEntry(data: Buffer): DecodedEntry | undefined {
	if (data.length < 4) return;
	const prelude = data.readUInt32BE(0);
	let position = 4;
	if (prelude & HAS_PREVIOUS_RESIDENCY_ID) position += 4;
	if (prelude & HAS_PREVIOUS_VERSION) position += 8;
	const replicatedStart = position;
	if (data[position] === PREVIOUS_VERSION_FIRST_BYTE) position += 8;
	cursor.position = position;
	const action = readVarint(data, cursor);
	const nodeId = readVarint(data, cursor);
	const tableId = readVarint(data, cursor);
	const idLength = readVarint(data, cursor);
	if (action === undefined || nodeId === undefined || tableId === undefined || idLength === undefined) return;
	const idStart = cursor.position;
	// the record version follows the id; an entry too short to hold it is not a well-formed audit entry
	if (idStart + idLength + 8 > data.length) return;
	return {
		isDelete: (action & 0xf) === DELETE_ACTION,
		// the decimal table id cannot contain ':', so the key is unambiguous
		recordKey: tableId + ':' + data.toString('latin1', idStart, idStart + idLength),
		replicatedStart,
	};
}

function readFully(fd: number, buffer: Buffer, length: number, position: number): void {
	let read = 0;
	while (read < length) {
		const bytes = readSync(fd, buffer, read, length - read, position + read);
		if (bytes === 0) throw new RepairRefusedError(`unexpected end of file at offset ${position + read}`);
		read += bytes;
	}
}

class OutputWriter {
	#fd: number | undefined;
	#buffer = Buffer.allocUnsafe(1 << 20);
	#used = 0;
	#hash: Hash = createHash('sha256');
	length = 0;

	constructor(fd: number | undefined) {
		this.#fd = fd;
	}

	write(bytes: Buffer): void {
		this.#hash.update(bytes);
		this.length += bytes.length;
		if (this.#fd === undefined) return;
		if (this.#used + bytes.length > this.#buffer.length) this.#flush();
		if (bytes.length > this.#buffer.length) this.#writeAll(bytes);
		else {
			bytes.copy(this.#buffer, this.#used);
			this.#used += bytes.length;
		}
	}

	finish(): string {
		if (this.#fd !== undefined) this.#flush();
		return this.#hash.digest('hex');
	}

	#flush(): void {
		this.#writeAll(this.#buffer.subarray(0, this.#used));
		this.#used = 0;
	}

	#writeAll(bytes: Buffer): void {
		let written = 0;
		while (written < bytes.length) written += writeSync(this.#fd, bytes, written, bytes.length - written);
	}
}

/**
 * A carried run must hold no records when the previous file ends mid-transaction (only older writers split
 * one): this file's first entry is then always kept, so the transaction keeps an entry here for its last flag.
 */
export function compactLogFile(path: string, options: CompactOptions = {}): FileScan {
	const maxSpanBytes = options.maxSpanBytes ?? MAX_SPAN_BYTES;
	const maxEntryBytes = options.maxEntryBytes ?? MAX_ENTRY_BYTES;
	const fd = openSync(path, 'r');
	try {
		const size = fstatSync(fd).size;
		const inputHash = createHash('sha256');
		const output = new OutputWriter(options.output);
		const fileHeader = Buffer.allocUnsafe(FILE_HEADER_SIZE);
		readFully(fd, fileHeader, FILE_HEADER_SIZE, 0);
		if (fileHeader.readUInt32BE(0) !== rocksConstants.TRANSACTION_LOG_TOKEN || fileHeader[4] !== FORMAT_VERSION)
			throw new RepairRefusedError(`${path} is not a version ${FORMAT_VERSION} transaction log file`);
		inputHash.update(fileHeader);
		output.write(fileHeader);
		const scan: FileScan = {
			entries: 0,
			kept: 0,
			dropped: 0,
			bytesIn: 0,
			bytesOut: 0,
			largestSpanIn: 0,
			largestSpanOut: 0,
			endsUnclosed: false,
			latestTimestamp: fileHeader.readDoubleBE(FILE_TIMESTAMP_OFFSET),
			trailing: undefined,
			inputSha256: '',
			outputSha256: '',
		};
		let entry = Buffer.allocUnsafe(64 * 1024);
		let pending = Buffer.allocUnsafe(64 * 1024);
		let pendingLength = 0;
		let pendingOpensBatch = false;
		const carry = options.carry;
		let spanRecords = carry?.records ?? new Map<string, Buffer | null>();
		let spanBytes = carry?.bytes ?? 0;
		let spanTimestamp = carry?.timestamp;
		let spanIn = carry?.sizeIn ?? 0;
		let spanOut = carry?.sizeOut ?? 0;
		let offset = FILE_HEADER_SIZE;
		let lastFlags = LAST_FLAG;
		while (offset < size) {
			if (options.flushedOffset === offset) scan.mappedFlushedOffset = output.length + pendingLength;
			if (offset + ENTRY_HEADER_SIZE > size) throw new RepairRefusedError(`${path} has a torn entry at ${offset}`);
			readFully(fd, entry, ENTRY_HEADER_SIZE, offset);
			const timestamp = entry.readDoubleBE(0);
			const length = entry.readUInt32BE(8);
			const flags = entry[ENTRY_FLAGS_OFFSET];
			const entrySize = ENTRY_HEADER_SIZE + length;
			if (timestamp === 0 || offset + entrySize > size)
				throw new RepairRefusedError(`${path} has a torn entry at ${offset}`);
			if (length > maxEntryBytes)
				throw new RepairRefusedError(`${path} holds a ${length}-byte entry at ${offset}, above ${maxEntryBytes}`);
			if (entrySize > entry.length) {
				const larger = Buffer.allocUnsafe(entrySize);
				entry.copy(larger, 0, 0, ENTRY_HEADER_SIZE);
				entry = larger;
			}
			readFully(fd, entry.subarray(ENTRY_HEADER_SIZE), length, offset + ENTRY_HEADER_SIZE);
			const bytes = entry.subarray(0, entrySize);
			inputHash.update(bytes);
			offset += entrySize;
			if (timestamp > scan.latestTimestamp) scan.latestTimestamp = timestamp;
			scan.entries++;
			scan.bytesIn += entrySize;
			lastFlags = flags;
			if (timestamp !== spanTimestamp) {
				scan.largestSpanIn = Math.max(scan.largestSpanIn, spanIn);
				scan.largestSpanOut = Math.max(scan.largestSpanOut, spanOut);
				spanTimestamp = timestamp;
				spanRecords = new Map();
				spanBytes = 0;
				spanIn = 0;
				spanOut = 0;
			}
			spanIn += entrySize;
			let drop = false;
			const data = bytes.subarray(ENTRY_HEADER_SIZE);
			const decoded = decodeEntry(data);
			if (!decoded) {
				spanRecords.clear();
				spanBytes = 0;
			} else {
				const replicated = data.subarray(decoded.replicatedStart);
				const previous = spanRecords.get(decoded.recordKey);
				if (decoded.isDelete && previous?.equals(replicated)) drop = true;
				else {
					spanBytes +=
						(decoded.isDelete ? replicated.length : 0) -
						(previous?.length ?? 0) +
						(previous === undefined ? decoded.recordKey.length + SPAN_ENTRY_OVERHEAD : 0);
					// stopping deduplication here instead could leave the run above the payload cap
					if (spanBytes > maxSpanBytes)
						throw new RepairRefusedError(
							`${path} has a run of one timestamp at ${offset} whose records need more than ${maxSpanBytes} bytes to compare`
						);
					spanRecords.set(decoded.recordKey, decoded.isDelete ? Buffer.from(replicated) : null);
				}
			}
			if (drop) {
				scan.dropped++;
				if (flags & LAST_FLAG) {
					if (pendingOpensBatch) pending[ENTRY_FLAGS_OFFSET] |= LAST_FLAG;
					pendingOpensBatch = false;
				}
				continue;
			}
			if (pendingLength) output.write(pending.subarray(0, pendingLength));
			if (entrySize > pending.length) pending = Buffer.allocUnsafe(entrySize);
			bytes.copy(pending);
			pendingLength = entrySize;
			pendingOpensBatch = !(flags & LAST_FLAG);
			scan.kept++;
			spanOut += entrySize;
		}
		if (pendingLength) output.write(pending.subarray(0, pendingLength));
		if (options.flushedOffset === offset) scan.mappedFlushedOffset = output.length;
		scan.largestSpanIn = Math.max(scan.largestSpanIn, spanIn);
		scan.largestSpanOut = Math.max(scan.largestSpanOut, spanOut);
		scan.trailing = {
			timestamp: spanTimestamp,
			records: spanRecords,
			bytes: spanBytes,
			sizeIn: spanIn,
			sizeOut: spanOut,
		};
		scan.endsUnclosed = scan.entries > 0 && !(lastFlags & LAST_FLAG);
		scan.bytesOut = output.length - FILE_HEADER_SIZE;
		scan.inputSha256 = inputHash.digest('hex');
		scan.outputSha256 = output.finish();
		return scan;
	} finally {
		closeSync(fd);
	}
}

interface LogFile {
	sequence: number;
	name: string;
	path: string;
	stats: Stats;
	boundary: number;
	scan?: FileScan;
	refused?: string;
}

interface LogStore {
	name: string;
	dir: string;
	files: LogFile[];
	txnState?: LogPosition;
	refused?: string;
}

export interface LogReport {
	name: string;
	files: number;
	rewritten: string[];
	refused: Array<{ file: string; reason: string }>;
	entries: number;
	dropped: number;
	bytesReclaimed: number;
	largestSpanBefore: number;
	largestSpanAfter: number;
	createdTailFile?: string;
}

export interface DatabaseReport {
	path: string;
	logs: LogReport[];
	refused?: string;
	backupDir?: string;
	/** Backups of repairs that stopped while still `preparing`, so before the store was touched. */
	removedBackups: string[];
	applied: boolean;
}

export interface RepairOptions {
	apply?: boolean;
	maxSpanBytes?: number;
	/** Test seam for crash injection: called after each durable step of an apply. */
	afterStep?: (step: string) => void;
}

function sha256File(path: string): string {
	const hash = createHash('sha256');
	const buffer = Buffer.allocUnsafe(1 << 20);
	const fd = openSync(path, 'r');
	try {
		let position = 0;
		let bytes: number;
		while ((bytes = readSync(fd, buffer, 0, buffer.length, position)) > 0) {
			hash.update(buffer.subarray(0, bytes));
			position += bytes;
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest('hex');
}

function fsyncPath(path: string): void {
	const fd = openSync(path, 'r');
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function writeDurably(path: string, bytes: Buffer, mode: number): void {
	const fd = openSync(path, 'wx', 0o600);
	try {
		fchmodSync(fd, mode);
		let written = 0;
		while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function encodeTxnState(position: LogPosition): Buffer {
	// a raw host-endian LogPosition { uint32 positionInLogFile, uint32 logSequenceNumber }
	const bytes = Buffer.alloc(TXN_STATE_SIZE);
	bytes.writeUInt32LE(position.offset, 0);
	bytes.writeUInt32LE(position.sequence, 4);
	return bytes;
}

function readTxnState(path: string): LogPosition | undefined {
	if (!existsSync(path)) return;
	const bytes = readFileSync(path);
	if (bytes.length !== TXN_STATE_SIZE) throw new RepairRefusedError(`${path} is ${bytes.length} bytes, expected 8`);
	return { offset: bytes.readUInt32LE(0), sequence: bytes.readUInt32LE(4) };
}

function assertRegularFile(path: string, stats: Stats): void {
	if (!stats.isFile()) throw new RepairRefusedError(`${path} is not a regular file`);
	if (stats.nlink !== 1) throw new RepairRefusedError(`${path} has ${stats.nlink} hard links`);
}

function readBoundary(path: string): number {
	const stats = lstatSync(path);
	assertRegularFile(path, stats);
	const bytes = readFileSync(path);
	if (
		bytes.length !== BOUNDARY_MARKER_SIZE ||
		bytes.readUInt32BE(0) !== BOUNDARY_MARKER_TOKEN ||
		bytes.readUInt32BE(8) !== ~bytes.readUInt32BE(4) >>> 0
	)
		throw new RepairRefusedError(`${path} is not a valid append-boundary marker`);
	return bytes.readUInt32BE(4);
}

/** Refuses anything unrecognized: an unknown side file could hold byte positions a rewrite would invalidate. */
function inventory(databasePath: string): LogStore[] {
	const logsDir = join(databasePath, 'transaction_logs');
	const boundaryRoot = join(logsDir, BOUNDARY_DIR);
	const stores: LogStore[] = [];
	for (const entry of readdirSync(logsDir, { withFileTypes: true })) {
		if (entry.name === BOUNDARY_DIR) continue;
		const dir = join(logsDir, entry.name);
		if (!entry.isDirectory()) throw new RepairRefusedError(`unrecognized entry ${dir}`);
		const store: LogStore = { name: entry.name, dir, files: [] };
		stores.push(store);
		for (const file of readdirSync(dir)) {
			const path = join(dir, file);
			const stats = lstatSync(path);
			if (file === TXN_STATE) {
				if (!stats.isFile()) throw new RepairRefusedError(`${path} is not a regular file`);
				store.txnState = readTxnState(path);
				continue;
			}
			const match = LOG_FILE_PATTERN.exec(file);
			if (!match) throw new RepairRefusedError(`unrecognized file ${path}`);
			assertRegularFile(path, stats);
			store.files.push({ sequence: Number(match[1]), name: file, path, stats, boundary: 0 });
		}
		store.files.sort((a, b) => a.sequence - b.sequence);
	}
	if (existsSync(boundaryRoot)) {
		for (const logEntry of readdirSync(boundaryRoot, { withFileTypes: true })) {
			const dir = join(boundaryRoot, logEntry.name);
			if (!logEntry.isDirectory()) throw new RepairRefusedError(`unrecognized entry ${dir}`);
			const store = stores.find((candidate) => candidate.name === logEntry.name);
			for (const file of readdirSync(dir)) {
				const match = BOUNDARY_FILE_PATTERN.exec(file);
				if (!match) throw new RepairRefusedError(`unrecognized file ${join(dir, file)}`);
				const boundary = readBoundary(join(dir, file));
				const logFile = store?.files.find((candidate) => candidate.sequence === Number(match[1]));
				if (logFile) logFile.boundary = boundary;
			}
		}
	}
	return stores;
}

async function planStore(store: LogStore, maxSpanBytes: number): Promise<void> {
	const validation = await validateTransactionLogStore(store.dir, { strict: true });
	if (validation.errors.length > 0) {
		store.refused = `failed strict validation: ${validation.errors.join('; ')}`;
		return;
	}
	const last = store.files.at(-1);
	let previous: LogFile | undefined;
	// a carried map can be as large as the budget, so none outlives the file that continues it
	const chainTo = (next: LogFile | undefined) => {
		if (previous?.scan) previous.scan.trailing = undefined;
		previous = next;
	};
	for (const file of store.files) {
		const result = validation.files.find((candidate) => candidate.file === file.name);
		if (!result?.valid || result.warnings.length > 0 || result.validBytes !== file.stats.size) {
			file.refused = `failed strict validation: ${[...(result?.errors ?? ['not validated']), ...(result?.warnings ?? [])].join('; ')}`;
			chainTo(undefined);
			continue;
		}
		if (file.boundary !== 0) {
			file.refused = `has a retired append boundary (${file.boundary})`;
			chainTo(undefined);
			continue;
		}
		try {
			file.scan = compactLogFile(file.path, scanOptions(store, file, previous, previous?.scan, maxSpanBytes));
		} catch (error) {
			// retention on a running node can delete a file between the listing and the scan
			if (!(error instanceof RepairRefusedError) && error.code !== 'ENOENT') throw error;
			file.refused = error.message;
			chainTo(undefined);
			continue;
		}
		chainTo(file);
		if (file.scan.dropped === 0) continue;
		const flushedOffset = store.txnState?.sequence === file.sequence ? store.txnState.offset : undefined;
		if (flushedOffset !== undefined && file.scan.mappedFlushedOffset === undefined)
			file.refused = `the flushed position ${flushedOffset} in txn.state is not an entry boundary`;
		// the live file's unclosed tail is discarded at open only while it is the newest file
		else if (file === last && file.scan.endsUnclosed)
			file.refused = 'ends with an unclosed transaction; start and stop Harper once so it is recovered, then re-run';
	}
	chainTo(undefined);
}

function scanOptions(
	store: LogStore,
	file: LogFile,
	previousFile: LogFile | undefined,
	previous: FileScan | undefined,
	maxSpanBytes: number,
	output?: number
): CompactOptions {
	const trailing = previous?.trailing;
	return {
		output,
		maxSpanBytes,
		flushedOffset: store.txnState?.sequence === file.sequence ? store.txnState.offset : undefined,
		carry: trailing && {
			...trailing,
			// a transaction split across the boundary must keep an entry in each file for its last flag
			records: previous.endsUnclosed ? new Map() : trailing.records,
			bytes: previous.endsUnclosed ? 0 : trailing.bytes,
			// a refused file is not rewritten, so its part of the run keeps its original size
			sizeOut: previousFile?.refused ? trailing.sizeIn : trailing.sizeOut,
		},
	};
}

function toReport(store: LogStore): LogReport {
	const report: LogReport = {
		name: store.name,
		files: store.files.length,
		rewritten: [],
		refused: [],
		entries: 0,
		dropped: 0,
		bytesReclaimed: 0,
		largestSpanBefore: 0,
		largestSpanAfter: 0,
	};
	if (store.refused) report.refused.push({ file: '*', reason: store.refused });
	for (const file of store.files) {
		if (file.refused) report.refused.push({ file: file.name, reason: file.refused });
		const scan = file.scan;
		if (!scan) continue;
		report.entries += scan.entries;
		report.largestSpanBefore = Math.max(report.largestSpanBefore, scan.largestSpanIn);
		report.largestSpanAfter = Math.max(
			report.largestSpanAfter,
			file.refused ? scan.largestSpanIn : scan.largestSpanOut
		);
		if (isTarget(file)) {
			report.rewritten.push(file.name);
			report.dropped += scan.dropped;
			report.bytesReclaimed += scan.bytesIn - scan.bytesOut;
		}
	}
	return report;
}

function isTarget(file: LogFile): boolean {
	return !file.refused && (file.scan?.dropped ?? 0) > 0;
}

interface ManifestLog {
	name: string;
	replaced: Array<{ file: string; originalSize: number; originalSha256: string; size: number; sha256: string }>;
	created: string[];
	txnState?: { original: LogPosition; final: LogPosition };
}

interface Manifest {
	format: 1;
	/** `preparing` precedes every store mutation; `staged` onward, the store may have been changed. */
	state: 'preparing' | 'staged' | 'applied' | 'complete';
	logs: ManifestLog[];
}

function writeManifest(backupDir: string, manifest: Manifest): void {
	const path = join(backupDir, MANIFEST);
	const temporary = path + '.tmp';
	rmSync(temporary, { force: true });
	writeDurably(temporary, Buffer.from(JSON.stringify(manifest, null, '\t')), 0o600);
	renameSync(temporary, path);
	fsyncPath(backupDir);
}

function isPosition(position: any): boolean {
	return (
		Number.isInteger(position?.offset) &&
		Number.isInteger(position?.sequence) &&
		position.offset >= 0 &&
		position.offset <= 0xffffffff &&
		position.sequence >= 0 &&
		position.sequence <= 0xffffffff
	);
}

// restore may run as root, so every name it will write through is checked, not trusted
function readManifest(backupDir: string): Manifest {
	let manifest: any;
	try {
		manifest = JSON.parse(readFileSync(join(backupDir, MANIFEST), 'utf8'));
	} catch (error) {
		throw new RepairRefusedError(`${backupDir} has an unreadable manifest: ${error.message}`);
	}
	const valid =
		manifest?.format === 1 &&
		['preparing', 'staged', 'applied', 'complete'].includes(manifest.state) &&
		Array.isArray(manifest.logs) &&
		manifest.logs.every(
			(log: any) =>
				typeof log?.name === 'string' &&
				LOG_NAME_PATTERN.test(log.name) &&
				Array.isArray(log.replaced) &&
				log.replaced.every(
					(replaced: any) =>
						LOG_FILE_PATTERN.test(replaced?.file) &&
						SHA256_PATTERN.test(replaced.originalSha256) &&
						SHA256_PATTERN.test(replaced.sha256)
				) &&
				Array.isArray(log.created) &&
				log.created.every((name: any) => LOG_FILE_PATTERN.test(name)) &&
				(log.txnState === undefined || (isPosition(log.txnState.original) && isPosition(log.txnState.final)))
		);
	if (!valid) throw new RepairRefusedError(`${backupDir} has an invalid manifest`);
	return manifest;
}

/**
 * A writable handle holds RocksDB's own `LOCK`, a kernel lock that shuts Harper, or another repair, out of the
 * database from any process or pid namespace until it closes. Its transaction logs live in an empty directory
 * of their own: a store over the real ones would purge files when it closes, and every handle this process
 * opens on the database shares the holder's view of them.
 */
async function withDatabaseHeld<T>(databasePath: string, action: () => T | Promise<T>): Promise<T> {
	// the writable open rewrites RocksDB's MANIFEST, CURRENT and OPTIONS, which Harper must still be able to read
	if (!existsSync(databasePath)) throw new RepairRefusedError(`${databasePath} does not exist`);
	const owner = statSync(databasePath).uid;
	if (process.getuid && process.getuid() !== owner)
		throw new RepairRefusedError(`${databasePath} is owned by uid ${owner}; run as that user`);
	const holderLogs = mkdtempSync(join(tmpdir(), 'repair-delete-echo-runs-'));
	const holder = new RocksDatabase(databasePath, { transactionLogsPath: holderLogs });
	try {
		try {
			holder.open();
		} catch (error) {
			throw new RepairRefusedError(
				/\block\b/i.test(error.message)
					? `${databasePath} is open in another process (${error.message}); stop Harper, and any supervisor that restarts it, first`
					: `${databasePath} could not be opened: ${error.message}`
			);
		}
		try {
			return await action();
		} finally {
			holder.close();
		}
	} finally {
		rmSync(holderLogs, { recursive: true, force: true });
	}
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function backupDirs(databasePath: string): string[] {
	return readdirSync(databasePath)
		.filter((name) => name.startsWith(BACKUP_PREFIX))
		.map((name) => join(databasePath, name));
}

function unfinishedRepairMessage(backupDir: string): string {
	return (
		`restore it with: node dist/bin/repairDeleteEchoRuns.js --restore ${backupDir}\n` +
		`or, if Harper has run on this database since, keep the database as it is (each file is wholly original or ` +
		`wholly repaired) by deleting ${backupDir}`
	);
}

// Files are never re-owned: the replacements must already belong to the user the originals do.
function assertOwnable(store: LogStore): void {
	const uid = process.getuid?.();
	if (uid === undefined) return;
	for (const file of store.files) {
		if (isTarget(file) && file.stats.uid !== uid)
			throw new RepairRefusedError(`${file.path} is owned by uid ${file.stats.uid}; run as that user`);
	}
}

export async function repairDatabase(path: string, options: RepairOptions = {}): Promise<DatabaseReport> {
	const databasePath = resolve(path);
	if (!options.apply) return (await planDatabase(databasePath, options)).report;
	const applied = await withDatabaseHeld(databasePath, () => applyDatabase(databasePath, options));
	if (!applied.manifest) return applied.report;
	applied.report.applied = true;
	for (const log of applied.report.logs) {
		const entry = applied.manifest.logs.find((candidate) => candidate.name === log.name);
		if (entry?.created.length) log.createdTailFile = entry.created[0];
	}
	return applied.report;
}

async function planDatabase(
	databasePath: string,
	options: RepairOptions
): Promise<{ report: DatabaseReport; stores?: LogStore[] }> {
	const report: DatabaseReport = { path: databasePath, logs: [], removedBackups: [], applied: false };
	try {
		for (const backupDir of backupDirs(databasePath)) {
			const state = existsSync(join(backupDir, MANIFEST)) ? readManifest(backupDir).state : undefined;
			if (state === 'complete') continue;
			if (state === 'preparing' && options.apply) {
				// interrupted before the store was touched; its links to live originals would refuse every inventory
				rmSync(backupDir, { recursive: true, force: true });
				report.removedBackups.push(backupDir);
				continue;
			}
			report.refused =
				state === undefined
					? `${backupDir} is not a repair this tool recorded; remove it if it is not needed`
					: state === 'preparing'
						? `${backupDir} is left from a repair interrupted before it changed anything; --apply removes it`
						: `an earlier repair did not finish; ${unfinishedRepairMessage(backupDir)}`;
			return { report };
		}
		const stores = inventory(databasePath);
		for (const store of stores) await planStore(store, options.maxSpanBytes ?? MAX_SPAN_BYTES);
		report.logs = stores.map(toReport);
		return { report, stores };
	} catch (error) {
		// retention on a running node can delete a file mid-listing
		if (!(error instanceof RepairRefusedError) && error.code !== 'ENOENT') throw error;
		report.refused = error.message;
		return { report };
	}
}

async function applyDatabase(
	databasePath: string,
	options: RepairOptions
): Promise<{ report: DatabaseReport; stores?: LogStore[]; manifest?: Manifest }> {
	const { report, stores } = await planDatabase(databasePath, options);
	const targets = stores?.filter((store) => store.files.some(isTarget)) ?? [];
	if (targets.length === 0) return { report };
	for (const store of targets) assertOwnable(store);
	const step = (name: string) => options.afterStep?.(name);
	const backupDir = join(databasePath, BACKUP_PREFIX + new Date().toISOString().replace(/[:.]/g, '-'));
	report.backupDir = backupDir;
	mkdirSync(backupDir, { mode: 0o700 });
	const manifest: Manifest = { format: 1, state: 'preparing', logs: [] };
	writeManifest(backupDir, manifest);
	fsyncPath(databasePath);
	step('preparing');
	try {
		for (const store of targets) manifest.logs.push(stageStore(store, join(backupDir, store.name), options));
		fsyncPath(backupDir);
		manifest.state = 'staged';
		writeManifest(backupDir, manifest);
	} catch (error) {
		rmSync(backupDir, { recursive: true, force: true });
		const failure = asError(error);
		failure.message = `${failure.message}\nNo changes were made to ${databasePath}.`;
		throw failure;
	}
	try {
		step('staged');
		for (const store of targets) {
			const entry = manifest.logs.find((candidate) => candidate.name === store.name);
			publishStore(store, entry, join(backupDir, store.name), (name) => step(`${store.name}: ${name}`));
		}
		manifest.state = 'applied';
		writeManifest(backupDir, manifest);
		step('applied');
		await verifyWritten(backupDir, stores, manifest);
		readBack(databasePath, stores, manifest);
		manifest.state = 'complete';
		writeManifest(backupDir, manifest);
	} catch (error) {
		const failure = asError(error);
		failure.message = `${failure.message}\nThe repair of ${databasePath} did not finish; ${unfinishedRepairMessage(backupDir)}`;
		throw failure;
	}
	return { report, stores, manifest };
}

function stageStore(store: LogStore, stagingDir: string, options: RepairOptions): ManifestLog {
	mkdirSync(stagingDir, { mode: 0o700 });
	const entry: ManifestLog = { name: store.name, replaced: [], created: [] };
	const maxSpanBytes = options.maxSpanBytes ?? MAX_SPAN_BYTES;
	let previousFile: LogFile | undefined;
	let previous: FileScan | undefined;
	// the same chain planning ran, so every carried run reaches the target files it did then
	for (const file of store.files) {
		if (!file.scan) {
			previousFile = previous = undefined;
			continue;
		}
		if (!isTarget(file)) {
			previous = compactLogFile(file.path, scanOptions(store, file, previousFile, previous, maxSpanBytes));
			previousFile = file;
			continue;
		}
		const staged = join(stagingDir, file.name + '.new');
		const flushedOffset = store.txnState?.sequence === file.sequence ? store.txnState.offset : undefined;
		const fd = openSync(staged, 'wx', 0o600);
		let scan: FileScan;
		try {
			fchmodSync(fd, file.stats.mode & 0o7777);
			scan = compactLogFile(file.path, scanOptions(store, file, previousFile, previous, maxSpanBytes, fd));
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		previousFile = file;
		previous = scan;
		if (scan.inputSha256 !== file.scan.inputSha256 || scan.outputSha256 !== file.scan.outputSha256)
			throw new RepairRefusedError(`${file.path} changed while being repaired; is Harper running?`);
		linkSync(file.path, join(stagingDir, file.name));
		entry.replaced.push({
			file: file.name,
			originalSize: file.stats.size,
			originalSha256: scan.inputSha256,
			size: scan.bytesOut + FILE_HEADER_SIZE,
			sha256: scan.outputSha256,
		});
		if (flushedOffset !== undefined)
			entry.txnState = {
				original: store.txnState,
				final: { offset: scan.mappedFlushedOffset, sequence: file.sequence },
			};
	}
	const last = store.files.at(-1);
	if (isTarget(last)) {
		// Coverage of a derived index is persisted as log byte positions and trusted when it equals the
		// committed tail. Moving the tail to a sequence that never existed means no stale position can match.
		const tailName = `${last.sequence + 1}.txnlog`;
		const header = Buffer.allocUnsafe(FILE_HEADER_SIZE);
		const fd = openSync(last.path, 'r');
		try {
			readFully(fd, header, FILE_HEADER_SIZE, 0);
		} finally {
			closeSync(fd);
		}
		// As a rotation writes it: a query starts in the newest file whose header timestamp is below its start,
		// so an older header would send every query for an existing entry past the files that hold it.
		header.writeDoubleBE(last.scan.latestTimestamp, FILE_TIMESTAMP_OFFSET);
		const staged = join(stagingDir, tailName + '.new');
		writeDurably(staged, header, last.stats.mode & 0o7777);
		entry.created.push(tailName);
	}
	fsyncPath(stagingDir);
	return entry;
}

/** Every intermediate state is one Harper can boot from: each file is wholly original or wholly repaired. */
function publishStore(store: LogStore, entry: ManifestLog, stagingDir: string, step: (name: string) => void): void {
	const publish = (staged: string, name: string) => {
		renameSync(staged, join(store.dir, name));
		fsyncPath(store.dir);
	};
	if (entry.txnState) {
		// Replay from the start of the file while it is being swapped: rewinding re-applies already flushed
		// writes, which replay tolerates, where a stale offset could skip unflushed ones.
		publish(
			writeTxnState(stagingDir, store.dir, { offset: FILE_HEADER_SIZE, sequence: entry.txnState.original.sequence }),
			TXN_STATE
		);
		step('rewound txn.state');
	}
	for (const name of entry.created) {
		publish(join(stagingDir, name + '.new'), name);
		step(`created ${name}`);
	}
	for (const { file } of entry.replaced) {
		publish(join(stagingDir, file + '.new'), file);
		step(`replaced ${file}`);
	}
	if (entry.txnState) {
		publish(writeTxnState(stagingDir, store.dir, entry.txnState.final), TXN_STATE);
		step('remapped txn.state');
	}
}

function writeTxnState(stagingDir: string, storeDir: string, position: LogPosition): string {
	const temporary = join(stagingDir, TXN_STATE + '.new');
	rmSync(temporary, { force: true });
	const live = join(storeDir, TXN_STATE);
	writeDurably(temporary, encodeTxnState(position), existsSync(live) ? lstatSync(live).mode & 0o7777 : 0o644);
	return temporary;
}

async function verifyWritten(backupDir: string, stores: LogStore[], manifest: Manifest): Promise<void> {
	for (const entry of manifest.logs) {
		const store = stores.find((candidate) => candidate.name === entry.name);
		for (const replaced of entry.replaced) {
			if (sha256File(join(store.dir, replaced.file)) !== replaced.sha256)
				throw new Error(`${join(store.dir, replaced.file)} does not hold the staged output`);
			// the backup is the replaced inode itself: a process that opened the store mid-repair appended there
			if (sha256File(join(backupDir, entry.name, replaced.file)) !== replaced.originalSha256)
				throw new Error(
					`${join(store.dir, replaced.file)} was written to during the repair; a process opened the database while it ran`
				);
		}
		// only what this repair wrote: an untouched file refused for a torn tail still fails strict validation
		const written = new Set([...entry.replaced.map(({ file }) => file), ...entry.created]);
		const validation = await validateTransactionLogStore(store.dir, { strict: true });
		const problems = [
			...validation.errors,
			...validation.files
				.filter((file) => written.has(file.file))
				.flatMap((file) => [...file.errors, ...file.warnings, ...(file.valid ? [] : [`${file.file} is invalid`])]),
		];
		if (problems.length > 0)
			throw new Error(`${store.dir} failed strict validation after the repair: ${problems.join('; ')}`);
	}
}

const READ_BACK_SCRIPT = `
const [rocksdb, databasePath, names] = process.argv.slice(1);
const { RocksDatabase } = require(rocksdb);
const database = new RocksDatabase(databasePath, { readOnly: true });
database.open();
const counts = {};
for (const name of JSON.parse(names)) {
	const entries = database.useLog(name).query({ start: 0 });
	let count = 0;
	while (!entries.next().done) count++;
	counts[name] = count;
}
database.close();
process.stdout.write('\\n' + JSON.stringify(counts));
`;

/**
 * Through rocksdb-js's own reader, which also enforces append boundaries. In a child process: every handle
 * this one opens shares the holder's empty log directory, and a read-only open takes no lock.
 */
function readBack(databasePath: string, stores: LogStore[], manifest: Manifest): void {
	const expected: Record<string, number> = {};
	for (const entry of manifest.logs) {
		const store = stores.find((candidate) => candidate.name === entry.name);
		// a refused file may hold a tail the reader stops at, so only fully planned logs have a known count
		if (store.files.some((file) => !file.scan)) continue;
		expected[entry.name] = store.files.reduce(
			(sum, file) => sum + (isTarget(file) ? file.scan.kept : file.scan.entries),
			0
		);
	}
	if (Object.keys(expected).length === 0) return;
	const result = spawnSync(
		process.execPath,
		[
			'-e',
			READ_BACK_SCRIPT,
			require.resolve('@harperfast/rocksdb-js'),
			databasePath,
			JSON.stringify(Object.keys(expected)),
		],
		{ encoding: 'utf8' }
	);
	if (result.status !== 0) throw new Error(`reading back ${databasePath} failed: ${result.stderr || result.error}`);
	const counts = JSON.parse(result.stdout.slice(result.stdout.lastIndexOf('\n') + 1));
	for (const [name, count] of Object.entries(expected)) {
		if (counts[name] !== count)
			throw new Error(`log ${name} of ${databasePath} reads back ${counts[name]} entries, expected ${count}`);
	}
}

/** Afterwards removes the backup directory, whose links to the restored originals would refuse a re-run. */
export async function restoreRepair(path: string): Promise<void> {
	const backupDir = resolve(path);
	// derived from where the backup lives, never recorded: a root that was moved or copied restores in place
	const databasePath = dirname(backupDir);
	if (!basename(backupDir).startsWith(BACKUP_PREFIX))
		throw new RepairRefusedError(`${backupDir} is not a repair backup directory`);
	const manifest = readManifest(backupDir);
	await withDatabaseHeld(databasePath, () => restoreHeld(backupDir, databasePath, manifest));
}

function assertPlain(path: string, isDirectory: boolean): void {
	if (!existsSync(path)) return;
	const stats = lstatSync(path);
	if (isDirectory ? !stats.isDirectory() : !stats.isFile())
		throw new RepairRefusedError(`${path} is not a regular ${isDirectory ? 'directory' : 'file'}`);
}

/**
 * Hashes and copies through one descriptor opened without following links, so a path swapped after the
 * check cannot change what a restore run as root writes into the store.
 */
function copyOriginal(source: string, target: string, sha256: string): void {
	const input = openSync(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	try {
		const stats = fstatSync(input);
		if (!stats.isFile() || stats.nlink !== 1) throw new RepairRefusedError(`${source} is not a singly linked file`);
		const output = openSync(target, 'wx', 0o600);
		const hash = createHash('sha256');
		try {
			const buffer = Buffer.allocUnsafe(1 << 20);
			let position = 0;
			let bytes: number;
			while ((bytes = readSync(input, buffer, 0, buffer.length, position)) > 0) {
				hash.update(buffer.subarray(0, bytes));
				let written = 0;
				while (written < bytes) written += writeSync(output, buffer, written, bytes - written, position + written);
				position += bytes;
			}
			fchmodSync(output, stats.mode & 0o7777);
			fsyncSync(output);
		} finally {
			closeSync(output);
		}
		if (hash.digest('hex') !== sha256) {
			rmSync(target);
			throw new RepairRefusedError(`${source} does not hold the original`);
		}
	} finally {
		closeSync(input);
	}
}

function restoreHeld(backupDir: string, databasePath: string, manifest: Manifest): void {
	assertPlain(backupDir, true);
	assertPlain(join(databasePath, 'transaction_logs'), true);
	// Anything but the original or the repaired bytes means Harper wrote to the store since: restoring would lose it.
	const moved = (target: string) =>
		new RepairRefusedError(
			`${target} has been written to since the repair, so restoring would lose those writes; keep the database as it is by deleting ${backupDir}`
		);
	for (const entry of manifest.logs) {
		const storeDir = join(databasePath, 'transaction_logs', entry.name);
		assertPlain(storeDir, true);
		assertPlain(join(backupDir, entry.name), true);
		assertPlain(join(storeDir, TXN_STATE), false);
		for (const name of entry.created) {
			const created = join(storeDir, name);
			assertPlain(created, false);
			if (existsSync(created) && lstatSync(created).size !== FILE_HEADER_SIZE) throw moved(created);
		}
		for (const replaced of entry.replaced) {
			const target = join(storeDir, replaced.file);
			assertPlain(target, false);
			const current = existsSync(target) ? sha256File(target) : undefined;
			if (current !== replaced.originalSha256 && current !== replaced.sha256) throw moved(target);
			if (current === replaced.originalSha256) continue;
			const original = join(backupDir, entry.name, replaced.file);
			// checked again, through the descriptor it copies from, by copyOriginal
			const stats = existsSync(original) ? lstatSync(original) : undefined;
			if (!stats?.isFile() || stats.nlink !== 1 || sha256File(original) !== replaced.originalSha256)
				throw new RepairRefusedError(`${original} is missing, linked or changed; it cannot be restored from`);
		}
	}
	for (const entry of manifest.logs) {
		const storeDir = join(databasePath, 'transaction_logs', entry.name);
		const stagingDir = join(backupDir, entry.name);
		// the same rewind the repair published under, so no swap in between can leave an offset mid-entry
		if (entry.txnState)
			renameSync(
				writeTxnState(stagingDir, storeDir, { offset: FILE_HEADER_SIZE, sequence: entry.txnState.original.sequence }),
				join(storeDir, TXN_STATE)
			);
		for (const name of entry.created) rmSync(join(storeDir, name), { force: true });
		for (const replaced of entry.replaced) {
			const target = join(storeDir, replaced.file);
			if (existsSync(target) && sha256File(target) === replaced.originalSha256) continue;
			// a copy, not a link: rocksdb-js appends to its newest file in place, which must not reach the backup
			const temporary = join(stagingDir, replaced.file + '.restore');
			rmSync(temporary, { force: true });
			copyOriginal(join(stagingDir, replaced.file), temporary, replaced.originalSha256);
			renameSync(temporary, target);
		}
		if (entry.txnState)
			renameSync(writeTxnState(stagingDir, storeDir, entry.txnState.original), join(storeDir, TXN_STATE));
		fsyncPath(storeDir);
	}
	rmSync(backupDir, { recursive: true });
}

export interface DatabaseEntry {
	/** Real path, links resolved: the backup directory belongs beside the files it links to. */
	path: string;
	refused?: string;
}

export function listDatabases(root: string): DatabaseEntry[] {
	if (process.platform === 'win32' || endianness() !== 'LE')
		throw new RepairRefusedError('supported on little-endian POSIX platforms only');
	const storageRoot = join(root, 'database');
	if (!existsSync(storageRoot) || !statSync(storageRoot).isDirectory())
		throw new RepairRefusedError(`${storageRoot} is not a directory`);
	const databases: DatabaseEntry[] = [];
	for (const entry of readdirSync(storageRoot, { withFileTypes: true })) {
		const path = join(storageRoot, entry.name);
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		try {
			const real = realpathSync(path);
			if (!statSync(real).isDirectory() || !existsSync(join(real, 'transaction_logs'))) continue;
			databases.push(
				lstatSync(join(real, 'transaction_logs')).isSymbolicLink()
					? { path: real, refused: 'transaction_logs is a symbolic link' }
					: { path: real }
			);
		} catch (error) {
			databases.push({ path, refused: `cannot be resolved: ${asError(error).message}` });
		}
	}
	return databases;
}

export async function repairHarperRoot(root: string, options: RepairOptions = {}): Promise<DatabaseReport[]> {
	const reports: DatabaseReport[] = [];
	for (const { path, refused } of listDatabases(root)) {
		const refuse = (reason: string) =>
			reports.push({ path, logs: [], removedBackups: [], applied: false, refused: reason });
		if (refused) {
			refuse(refused);
			continue;
		}
		try {
			reports.push(await repairDatabase(path, options));
		} catch (error) {
			refuse(error instanceof RepairRefusedError ? error.message : (asError(error).stack ?? String(error)));
		}
	}
	return reports;
}
