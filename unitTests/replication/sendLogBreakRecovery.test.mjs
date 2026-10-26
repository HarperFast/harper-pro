/**
 * The send loop reconnects past a torn-tail stop only when a fresh range reads past it; otherwise a
 * quiet torn log beside busy healthy logs would reconnect on every commit.
 */

import { expect } from 'chai';
import { freshSendRangeReadsPast, maybeDeadAuditIterableForTest } from '#src/replication/replicationConnection';

function probe(entries, { breaks = 0, failedLogs = [] } = {}) {
	return {
		*[Symbol.iterator]() {
			yield* entries;
		},
		corruptFrameStop: { breaks, truncatedVersions: new Set(), midLogBreak: false },
		failedLogs: new Set(failedLogs),
	};
}

describe('freshSendRangeReadsPast', () => {
	it('is true when the fresh range drains with no corrupt frame', () => {
		expect(freshSendRangeReadsPast(probe([1, 2]))).to.equal(true);
		expect(freshSendRangeReadsPast(probe([]))).to.equal(true);
	});

	it('is false when the fresh range stops at a corrupt frame, even after yielding healthy entries', () => {
		// A healthy log in the merged range can yield while the torn one still stops: no reconnect.
		expect(freshSendRangeReadsPast(probe([1, 2], { breaks: 1 }))).to.equal(false);
	});

	it('is false when a log in the fresh range failed', () => {
		expect(freshSendRangeReadsPast(probe([], { failedLogs: ['local'] }))).to.equal(false);
	});

	it('reads breaks only after draining, since core records them during iteration', () => {
		const range = {
			corruptFrameStop: { breaks: 0, truncatedVersions: new Set(), midLogBreak: false },
			failedLogs: new Set(),
			*[Symbol.iterator]() {
				yield 1;
				range.corruptFrameStop.breaks++;
			},
		};
		expect(freshSendRangeReadsPast(range)).to.equal(false);
	});

	it('accepts a store without corrupt-frame reporting', () => {
		expect(freshSendRangeReadsPast([1, 2, 3])).to.equal(true);
	});
});

describe('maybeDeadAuditIterableForTest', () => {
	it('is inert without the test environment variable', () => {
		expect(maybeDeadAuditIterableForTest('data')).to.equal(undefined);
	});
});
