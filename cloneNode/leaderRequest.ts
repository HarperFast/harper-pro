import { postToLeader, readLeaderResponse, type LeaderHTTPTarget } from './leaderHTTP.ts';

export const LEADER_REQUEST_DEADLINE_MS = 2 * 60 * 1000;
/** A buffered package: a leader that predates streaming builds the whole archive before sending a byte. */
export const LEADER_PACKAGE_DEADLINE_MS = 30 * 60 * 1000;

export type LeaderTransport = { http: LeaderHTTPTarget } | { replicationURL: string; rejectUnauthorized: boolean };

async function requestOverHTTP(target: LeaderHTTPTarget, operation: any, deadlineMs: number): Promise<any> {
	const deadline = new AbortController();
	const timer = setTimeout(
		() => deadline.abort(new Error(`${operation.operation} to the leader did not answer within ${deadlineMs}ms`)),
		deadlineMs
	);
	try {
		return await readLeaderResponse(await postToLeader(target, operation, undefined, deadline.signal));
	} catch (error) {
		throw deadline.signal.aborted ? deadline.signal.reason : error;
	} finally {
		clearTimeout(timer);
	}
}

/** One message answered in full by the deadline, so a leader that accepts and never finishes is a failed attempt. */
export async function requestLeader(
	transport: LeaderTransport,
	operation: { operation: string; [key: string]: any },
	deadlineMs: number = LEADER_REQUEST_DEADLINE_MS
): Promise<any> {
	if ('http' in transport) return requestOverHTTP(transport.http, operation, deadlineMs);
	// Dynamic: loading the replicator reads the root path, which is not set yet during install.
	const { sendOperationToNode } = await import('../replication/replicator.js');
	const answer: any = await sendOperationToNode({ url: transport.replicationURL }, operation, {
		rejectUnauthorized: transport.rejectUnauthorized,
		timeoutMs: deadlineMs,
	});
	// The replication socket answers an array as `{ results }`, so it can carry the request id; HTTP sends the array.
	return Array.isArray(answer?.results) ? answer.results : answer;
}
