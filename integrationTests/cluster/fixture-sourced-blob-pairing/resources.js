import { Readable } from 'node:stream';
import { threadId } from 'node:worker_threads';

const originUrl = process.env.HARPER_TEST_ORIGIN_URL;
// Keep payloads above core's 8 KiB inline-storage threshold.
const payloadSize = 16 * 1024;

function payloadFor(token) {
	const bytes = Buffer.alloc(payloadSize, 0x2e);
	bytes.write(token);
	return createBlob(Readable.from(bytes));
}

tables.PairRecord.sourcedFrom({
	async get(id, context) {
		const response = await fetch(`${originUrl}/resolve`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id, node: server.hostname, threadId }),
		});
		if (!response.ok) throw new Error(`Pairing origin returned ${response.status}: ${await response.text()}`);
		const resolved = await response.json();
		// When the origin reports a shared lastModified, both nodes mint the *same* record version,
		// so their competing fills tie. A tie is the case cache-fill resolution cannot order by node
		// identity, and the only one version-ordered LWW never reaches.
		if (resolved.lastModified != null) context.lastModified = resolved.lastModified;
		return {
			id,
			token: resolved.token,
			sourceNode: server.hostname,
			sourceThread: threadId,
			payload: payloadFor(resolved.token),
		};
	},
});

function describeRecord(record) {
	if (!record?.payload) return null;
	return record.payload.bytes().then((bytes) => ({
		id: record.id,
		token: record.token,
		sourceNode: record.sourceNode,
		sourceThread: record.sourceThread,
		payloadToken: bytes.subarray(0, Buffer.byteLength(record.token)).toString(),
	}));
}

export class PairPointProbe extends tables.PairRecord {
	static async get(target) {
		const record = await super.get(target);
		let raw;
		for (const entry of tables.PairRecord.primaryStore.getRange({
			start: target.id,
			versions: true,
			snapshot: false,
		})) {
			if (entry.key === target.id)
				raw = { version: entry.version, nodeId: entry.nodeId, record: await describeRecord(entry.value) };
			break;
		}
		return { node: server.hostname, threadId, record: await describeRecord(record), raw };
	}
}

export class PairScanProbe extends Resource {
	static loadAsInstance = false;

	async get(target) {
		target.checkPermission = false;
		for (const entry of tables.PairRecord.primaryStore.getRange({
			start: target.id,
			versions: true,
			snapshot: false,
		})) {
			if (entry.key !== target.id) break;
			return {
				node: server.hostname,
				threadId,
				version: entry.version,
				nodeId: entry.nodeId,
				record: await describeRecord(entry.value),
			};
		}
		return { node: server.hostname, threadId, record: null };
	}
}

export class PairWorker extends Resource {
	static loadAsInstance = false;

	get(target) {
		target.checkPermission = false;
		return { threadId };
	}
}
