/**
 * Offline repair for RocksDB transaction logs that releases before harper#2761 filled with echoed copies
 * of a replicated delete (harper-pro#826; replication/DESIGN.md item 20). Every copy carries the origin
 * transaction's timestamp, and the replication sender frames consecutive entries of one timestamp as one
 * message, so a run above `replication_maxPayload` closes the leg on every reconnect.
 *
 * A delete is dropped only when its replicated bytes (everything after Harper's local prelude) equal a
 * delete of the same record kept earlier in the same run of one timestamp in the same file, with no other
 * entry for that record in between. Everything else is copied verbatim, in order. Harper must be stopped:
 * outputs are staged and originals hard-linked into a backup directory, a manifest is written, and only
 * then is the store touched, one atomic rename at a time. `restoreRepair` puts the originals back.
 *
 * Only `node:` built-ins and rocksdb-js are imported: Harper's runtime modules initialize configuration,
 * logging and storage when loaded.
 */
import {
	chmodSync,
	chownSync,
	closeSync,
	copyFileSync,
	constants as fsConstants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	writeSync,
	existsSync,
	type Stats,
} from 'node:fs';
import { createHash, type Hash } from 'node:crypto';
import { endianness } from 'node:os';
import { join, resolve } from 'node:path';
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
/** Distinct records tracked per same-timestamp run before that run is copied without deduplication. */
export const MAX_SPAN_RECORDS = 1_000_000;
const BACKUP_PREFIX = 'transaction_logs.repair-';
const MANIFEST = 'manifest.json';
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
	/** Runs with more distinct records than `maxSpanRecords`, copied from that point without deduplication. */
	saturatedSpans: number;
	/** The last entry does not close its transaction. */
	endsUnclosed: boolean;
	/** The larger of the file header's timestamp and every entry's. */
	latestTimestamp: number;
	/** Where `flushedOffset` lands in the output, when it is an entry boundary of the input. */
	mappedFlushedOffset?: number;
	inputSha256: string;
	outputSha256: string;
}

export interface CompactOptions {
	/** Descriptor to write the compacted file to; omitted for a dry run. */
	output?: number;
	flushedOffset?: number;
	maxSpanRecords?: number;
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
export function decodeEntry(data: Buffer): DecodedEntry | undefined {
	if (data.length < 4) return;
	const prelude = data.readUInt32BE(0);
	let position = 4;
	if (prelude & HAS_PREVIOUS_RESIDENCY_ID) position += 4;
	if (prelude & HAS_PREVIOUS_VERSION) position += 8;
	const replicatedStart = position;
	if (data[position] === PREVIOUS_VERSION_FIRST_BYTE) position += 8;
	const cursor = { position };
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
		if (bytes === 0) throw new Error(`unexpected end of file at offset ${position + read}`);
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
 * Streams one `.txnlog` file, deciding which entries to keep; writes the kept entries to
 * `options.output` when given. Span state resets at every file start, so a file's first entry is always
 * kept and a transaction continued from the previous file keeps an entry here to carry its last flag.
 */
export function compactLogFile(path: string, options: CompactOptions = {}): FileScan {
	const maxSpanRecords = options.maxSpanRecords ?? MAX_SPAN_RECORDS;
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
			saturatedSpans: 0,
			endsUnclosed: false,
			latestTimestamp: fileHeader.readDoubleBE(FILE_TIMESTAMP_OFFSET),
			inputSha256: '',
			outputSha256: '',
		};
		let entry = Buffer.allocUnsafe(64 * 1024);
		// The last kept entry is held back so a dropped copy that closed the transaction can move its last flag here.
		let pending = Buffer.allocUnsafe(64 * 1024);
		let pendingLength = 0;
		let pendingOpensBatch = false;
		const spanRecords = new Map<string, Buffer | null>();
		let spanTimestamp: number | undefined;
		let spanSaturated = false;
		let spanIn = 0;
		let spanOut = 0;
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
				spanRecords.clear();
				spanSaturated = false;
				spanIn = 0;
				spanOut = 0;
			}
			spanIn += entrySize;
			let drop = false;
			if (!spanSaturated) {
				const data = bytes.subarray(ENTRY_HEADER_SIZE);
				const decoded = decodeEntry(data);
				if (!decoded) spanRecords.clear();
				else {
					const replicated = data.subarray(decoded.replicatedStart);
					const previous = spanRecords.get(decoded.recordKey);
					if (decoded.isDelete && previous?.equals(replicated)) drop = true;
					else if (previous === undefined && spanRecords.size >= maxSpanRecords) {
						spanSaturated = true;
						spanRecords.clear();
						scan.saturatedSpans++;
					} else spanRecords.set(decoded.recordKey, decoded.isDelete ? Buffer.from(replicated) : null);
				}
			}
			if (drop) {
				scan.dropped++;
				if (flags & LAST_FLAG) {
					// no kept entry of this transaction in this file means every entry was a copy: it goes whole
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
	saturatedSpans: number;
	createdTailFile?: string;
}

export interface DatabaseReport {
	path: string;
	logs: LogReport[];
	refused?: string;
	backupDir?: string;
	applied: boolean;
}

export interface RepairOptions {
	apply?: boolean;
	maxSpanRecords?: number;
	/** Throws when Harper is running; called before the store is first touched and before every rename. */
	assertStopped?: () => void;
	/** Test seam for crash injection: called after each durable step of an apply. */
	afterStep?: (step: string) => void;
}

function sha256File(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
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
	const fd = openSync(path, 'wx', mode);
	try {
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

/**
 * Lists the log stores of one database, refusing anything the tool does not recognize: an unknown side
 * file could hold byte positions this rewrite would invalidate.
 */
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

async function planStore(store: LogStore, maxSpanRecords: number): Promise<void> {
	const validation = await validateTransactionLogStore(store.dir, { strict: true });
	if (validation.errors.length > 0) {
		store.refused = `failed strict validation: ${validation.errors.join('; ')}`;
		return;
	}
	const last = store.files.at(-1);
	for (const file of store.files) {
		const result = validation.files.find((candidate) => candidate.file === file.name);
		if (!result?.valid || result.warnings.length > 0 || result.validBytes !== file.stats.size) {
			file.refused = `failed strict validation: ${[...(result?.errors ?? ['not validated']), ...(result?.warnings ?? [])].join('; ')}`;
			continue;
		}
		if (file.boundary !== 0) {
			file.refused = `has a retired append boundary (${file.boundary})`;
			continue;
		}
		const flushedOffset = store.txnState?.sequence === file.sequence ? store.txnState.offset : undefined;
		try {
			file.scan = compactLogFile(file.path, { flushedOffset, maxSpanRecords });
		} catch (error) {
			if (!(error instanceof RepairRefusedError)) throw error;
			file.refused = error.message;
			continue;
		}
		if (file.scan.dropped === 0) continue;
		if (flushedOffset !== undefined && file.scan.mappedFlushedOffset === undefined)
			file.refused = `the flushed position ${flushedOffset} in txn.state is not an entry boundary`;
		// the live file's unclosed tail is discarded at open only while it is the newest file
		else if (file === last && file.scan.endsUnclosed)
			file.refused = 'ends with an unclosed transaction; start and stop Harper once so it is recovered, then re-run';
	}
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
		saturatedSpans: 0,
	};
	if (store.refused) report.refused.push({ file: '*', reason: store.refused });
	for (const file of store.files) {
		if (file.refused) report.refused.push({ file: file.name, reason: file.refused });
		const scan = file.scan;
		if (!scan) continue;
		report.entries += scan.entries;
		report.largestSpanBefore = Math.max(report.largestSpanBefore, scan.largestSpanIn);
		report.saturatedSpans += scan.saturatedSpans;
		if (isTarget(file)) {
			report.rewritten.push(file.name);
			report.dropped += scan.dropped;
			report.bytesReclaimed += scan.bytesIn - scan.bytesOut;
			report.largestSpanAfter = Math.max(report.largestSpanAfter, scan.largestSpanOut);
		} else report.largestSpanAfter = Math.max(report.largestSpanAfter, scan.largestSpanIn);
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
	database: string;
	state: 'staged' | 'applied' | 'complete';
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

function readManifest(backupDir: string): Manifest {
	const manifest = JSON.parse(readFileSync(join(backupDir, MANIFEST), 'utf8')) as Manifest;
	if (manifest.format !== 1) throw new RepairRefusedError(`${backupDir} has an unsupported manifest`);
	return manifest;
}

function unfinishedRepairs(databasePath: string): string[] {
	return readdirSync(databasePath)
		.filter((name) => name.startsWith(BACKUP_PREFIX) && existsSync(join(databasePath, name, MANIFEST)))
		.map((name) => join(databasePath, name))
		.filter((backupDir) => {
			const { state } = readManifest(backupDir);
			return state === 'staged' || state === 'applied';
		});
}

function restoreCommand(backupDir: string): string {
	return `node dist/bin/repairDeleteEchoRuns.js --restore ${backupDir}`;
}

/** Makes a staged file match the original's mode and owner before it replaces the original. */
function matchOwnership(path: string, original: Stats): void {
	chmodSync(path, original.mode & 0o7777);
	if (process.getuid?.() === 0) chownSync(path, original.uid, original.gid);
}

function assertOwnable(store: LogStore): void {
	const uid = process.getuid?.();
	if (uid === undefined || uid === 0) return;
	for (const file of store.files) {
		if (isTarget(file) && file.stats.uid !== uid)
			throw new RepairRefusedError(`${file.path} is owned by uid ${file.stats.uid}; run as that user or as root`);
	}
}

/**
 * Scans (and with `apply`, repairs) every transaction log of one RocksDB database directory.
 */
export async function repairDatabase(path: string, options: RepairOptions = {}): Promise<DatabaseReport> {
	const databasePath = resolve(path);
	const report: DatabaseReport = { path: databasePath, logs: [], applied: false };
	const unfinished = unfinishedRepairs(databasePath);
	if (unfinished.length > 0) {
		report.refused = `an earlier repair did not finish; restore it first: ${unfinished.map(restoreCommand).join(' ; ')}`;
		return report;
	}
	let stores: LogStore[];
	try {
		stores = inventory(databasePath);
	} catch (error) {
		if (!(error instanceof RepairRefusedError)) throw error;
		report.refused = error.message;
		return report;
	}
	for (const store of stores) await planStore(store, options.maxSpanRecords ?? MAX_SPAN_RECORDS);
	report.logs = stores.map(toReport);
	const targets = stores.filter((store) => store.files.some(isTarget));
	if (!options.apply || targets.length === 0) return report;
	for (const store of targets) assertOwnable(store);
	options.assertStopped?.();
	const backupDir = join(databasePath, BACKUP_PREFIX + new Date().toISOString().replace(/[:.]/g, '-'));
	report.backupDir = backupDir;
	mkdirSync(backupDir, { mode: 0o700 });
	const manifest: Manifest = { format: 1, database: databasePath, state: 'staged', logs: [] };
	try {
		for (const store of targets) manifest.logs.push(stageStore(store, join(backupDir, store.name), options));
		fsyncPath(backupDir);
		fsyncPath(databasePath);
		writeManifest(backupDir, manifest);
	} catch (error) {
		// the store is untouched, and without a manifest nothing refers to the backup directory
		rmSync(backupDir, { recursive: true, force: true });
		error.message = `${error.message}\nNo changes were made to ${databasePath}.`;
		throw error;
	}
	const step = (name: string) => options.afterStep?.(name);
	try {
		step('staged');
		for (const store of targets) {
			const entry = manifest.logs.find((candidate) => candidate.name === store.name);
			publishStore(store, entry, join(backupDir, store.name), options, (name) => step(`${store.name}: ${name}`));
		}
		manifest.state = 'applied';
		writeManifest(backupDir, manifest);
		step('applied');
		await verifyApplied(databasePath, stores, manifest);
		manifest.state = 'complete';
		writeManifest(backupDir, manifest);
	} catch (error) {
		error.message = `${error.message}\nThe repair of ${databasePath} did not finish; restore the originals with: ${restoreCommand(backupDir)}`;
		throw error;
	}
	report.applied = true;
	for (const log of report.logs) {
		const entry = manifest.logs.find((candidate) => candidate.name === log.name);
		if (entry?.created.length) log.createdTailFile = entry.created[0];
	}
	return report;
}

/** Writes every compacted file of one log store into `stagingDir` and hard-links the originals beside them. */
function stageStore(store: LogStore, stagingDir: string, options: RepairOptions): ManifestLog {
	mkdirSync(stagingDir, { mode: 0o700 });
	const entry: ManifestLog = { name: store.name, replaced: [], created: [] };
	for (const file of store.files.filter(isTarget)) {
		const staged = join(stagingDir, file.name + '.new');
		const flushedOffset = store.txnState?.sequence === file.sequence ? store.txnState.offset : undefined;
		const fd = openSync(staged, 'wx', 0o600);
		let scan: FileScan;
		try {
			scan = compactLogFile(file.path, { output: fd, flushedOffset, maxSpanRecords: options.maxSpanRecords });
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		if (scan.inputSha256 !== file.scan.inputSha256)
			throw new RepairRefusedError(`${file.path} changed while being repaired; is Harper running?`);
		matchOwnership(staged, file.stats);
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
		writeDurably(staged, header, 0o600);
		matchOwnership(staged, last.stats);
		entry.created.push(tailName);
	}
	if (entry.txnState) copyFileSync(join(store.dir, TXN_STATE), join(stagingDir, TXN_STATE), fsConstants.COPYFILE_EXCL);
	fsyncPath(stagingDir);
	return entry;
}

/** Moves one store's staged files into place, keeping every intermediate state safe to boot from. */
function publishStore(
	store: LogStore,
	entry: ManifestLog,
	stagingDir: string,
	options: RepairOptions,
	step: (name: string) => void
): void {
	const publish = (staged: string, name: string) => {
		options.assertStopped?.();
		renameSync(staged, join(store.dir, name));
		fsyncPath(store.dir);
	};
	const writeState = (position: LogPosition, suffix: string) => {
		const temporary = join(stagingDir, TXN_STATE + suffix);
		writeDurably(temporary, encodeTxnState(position), 0o600);
		matchOwnership(temporary, lstatSync(join(store.dir, TXN_STATE)));
		publish(temporary, TXN_STATE);
	};
	if (entry.txnState) {
		// Replay from the start of the file while it is being swapped: rewinding re-applies already flushed
		// writes, which replay tolerates, where a stale offset could skip unflushed ones.
		writeState({ offset: FILE_HEADER_SIZE, sequence: entry.txnState.original.sequence }, '.rewind');
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
		writeState(entry.txnState.final, '.final');
		step('remapped txn.state');
	}
}

async function verifyApplied(databasePath: string, stores: LogStore[], manifest: Manifest): Promise<void> {
	for (const entry of manifest.logs) {
		const store = stores.find((candidate) => candidate.name === entry.name);
		for (const replaced of entry.replaced) {
			if (sha256File(join(store.dir, replaced.file)) !== replaced.sha256)
				throw new Error(`${join(store.dir, replaced.file)} does not hold the staged output`);
		}
		const validation = await validateTransactionLogStore(store.dir, { strict: true });
		if (!validation.valid)
			throw new Error(
				`${store.dir} failed strict validation after the repair: ${[...validation.errors, ...validation.files.flatMap((file) => file.errors)].join('; ')}`
			);
	}
	// Read every repaired log back through rocksdb-js's own reader, which also enforces append boundaries.
	const database = new RocksDatabase(databasePath, { readOnly: true });
	database.open();
	try {
		for (const entry of manifest.logs) {
			const store = stores.find((candidate) => candidate.name === entry.name);
			// a refused file may hold a tail the reader stops at, so only fully planned logs have a known count
			if (store.files.some((file) => !file.scan)) continue;
			const expected = store.files.reduce(
				(sum, file) => sum + (isTarget(file) ? file.scan.kept : file.scan.entries),
				0
			);
			const entries = database.useLog(entry.name).query({ start: 0 });
			let count = 0;
			while (!entries.next().done) count++;
			if (count !== expected)
				throw new Error(`log ${entry.name} of ${databasePath} reads back ${count} entries, expected ${expected}`);
		}
	} finally {
		database.close();
	}
}

/**
 * Puts back every file a repair replaced, removes the files it created, restores `txn.state`, then removes
 * the backup directory.
 */
export function restoreRepair(path: string, options: Pick<RepairOptions, 'assertStopped'> = {}): void {
	const backupDir = resolve(path);
	const manifest = readManifest(backupDir);
	const assertStopped = options.assertStopped ?? (() => assertHarperStopped(join(manifest.database, '..', '..')));
	assertStopped();
	// Anything but the original or the repaired bytes means Harper wrote to the store since: restoring would lose it.
	for (const entry of manifest.logs) {
		const storeDir = join(manifest.database, 'transaction_logs', entry.name);
		for (const name of entry.created) {
			const created = join(storeDir, name);
			if (existsSync(created) && lstatSync(created).size !== FILE_HEADER_SIZE)
				throw new RepairRefusedError(`${created} has been written to since the repair; it cannot be restored`);
		}
		for (const replaced of entry.replaced) {
			const target = join(storeDir, replaced.file);
			const current = existsSync(target) ? sha256File(target) : undefined;
			if (current !== replaced.originalSha256 && current !== replaced.sha256)
				throw new RepairRefusedError(`${target} has changed since the repair; it cannot be restored`);
		}
	}
	for (const entry of manifest.logs) {
		const storeDir = join(manifest.database, 'transaction_logs', entry.name);
		const stagingDir = join(backupDir, entry.name);
		for (const name of entry.created) {
			assertStopped();
			rmSync(join(storeDir, name), { force: true });
		}
		for (const replaced of entry.replaced) {
			const target = join(storeDir, replaced.file);
			if (existsSync(target) && sha256File(target) === replaced.originalSha256) continue;
			const original = join(stagingDir, replaced.file);
			if (sha256File(original) !== replaced.originalSha256) throw new Error(`${original} does not hold the original`);
			// a copy, not a link: rocksdb-js appends to its newest file in place, which must not reach the backup
			const temporary = original + '.restore';
			rmSync(temporary, { force: true });
			copyFileSync(original, temporary, fsConstants.COPYFILE_EXCL);
			fsyncPath(temporary);
			matchOwnership(temporary, lstatSync(original));
			assertStopped();
			renameSync(temporary, target);
		}
		if (entry.txnState) {
			const temporary = join(stagingDir, TXN_STATE + '.restore');
			rmSync(temporary, { force: true });
			writeDurably(temporary, readFileSync(join(stagingDir, TXN_STATE)), 0o600);
			matchOwnership(temporary, lstatSync(join(stagingDir, TXN_STATE)));
			assertStopped();
			renameSync(temporary, join(storeDir, TXN_STATE));
		}
		fsyncPath(storeDir);
	}
	// every original is back in the store, and the backup's own links would otherwise count against it
	rmSync(backupDir, { recursive: true });
}

/**
 * Throws unless `<root>/hdb.pid` is absent or names a process that no longer exists.
 */
export function assertHarperStopped(root: string): void {
	const pidFile = join(root, 'hdb.pid');
	if (!existsSync(pidFile)) return;
	const text = readFileSync(pidFile, 'utf8').trim();
	if (!/^[1-9]\d*$/.test(text))
		throw new RepairRefusedError(`${pidFile} does not hold a process id; stop Harper and remove it`);
	try {
		process.kill(Number(text), 0);
	} catch (error) {
		if (error.code === 'ESRCH') return;
	}
	throw new RepairRefusedError(
		`Harper is running (pid ${text} from ${pidFile}); stop it, and any supervisor that restarts it, first`
	);
}

/**
 * Scans (and with `apply`, repairs) every RocksDB database under `<root>/database`.
 */
export async function repairHarperRoot(root: string, options: RepairOptions = {}): Promise<DatabaseReport[]> {
	if (process.platform === 'win32' || endianness() !== 'LE')
		throw new RepairRefusedError('supported on little-endian POSIX platforms only');
	const storageRoot = join(root, 'database');
	if (!existsSync(storageRoot)) throw new RepairRefusedError(`${storageRoot} does not exist`);
	const assertStopped = () => assertHarperStopped(root);
	if (options.apply) assertStopped();
	const reports: DatabaseReport[] = [];
	for (const entry of readdirSync(storageRoot, { withFileTypes: true })) {
		const databasePath = join(storageRoot, entry.name);
		if (!entry.isDirectory() || !existsSync(join(databasePath, 'transaction_logs'))) continue;
		if (lstatSync(join(databasePath, 'transaction_logs')).isSymbolicLink()) {
			reports.push({ path: databasePath, logs: [], applied: false, refused: 'transaction_logs is a symbolic link' });
			continue;
		}
		reports.push(await repairDatabase(databasePath, { ...options, assertStopped }));
	}
	return reports;
}
