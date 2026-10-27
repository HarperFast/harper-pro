// Runs on every blob-carrying copy frame, so it must read once, probe only same-version, same-node
// rows, and keep no state across frames.

import { expect } from 'chai';
import { resolveCopyFrameStoredBlobs } from '#src/replication/replicationConnection';

const blobA = new Blob(['a']);

function countingDecoder(entryFor) {
	const decoder = {
		reads: 0,
		getEntry(id) {
			decoder.reads++;
			return entryFor(id);
		},
	};
	return decoder;
}

function countingProbe(result) {
	const probe = async () => {
		probe.calls++;
		return result;
	};
	probe.calls = 0;
	return probe;
}

const whole = async () => true;
const torn = async () => false;

describe('resolveCopyFrameStoredBlobs', () => {
	it('returns the damaged blob of a same-version, same-node stored record, from one read', async () => {
		const decoder = countingDecoder(() => ({ version: 5, nodeId: 2, value: { x: blobA } }));
		const probe = countingProbe(true);
		expect(await resolveCopyFrameStoredBlobs(decoder, 'k', 5, 2, probe, {}, torn)).to.deep.equal({
			tie: false,
			repairTargets: [blobA],
		});
		expect(decoder.reads).to.equal(1);
		expect(probe.calls).to.equal(1);
	});

	it('awaits a cold (thenable) stored entry', async () => {
		const decoder = countingDecoder(() => Promise.resolve({ version: 5, nodeId: 2, value: { x: blobA } }));
		expect(await resolveCopyFrameStoredBlobs(decoder, 'k', 5, 2, async () => true, {}, torn)).to.deep.equal({
			tie: false,
			repairTargets: [blobA],
		});
		expect(await resolveCopyFrameStoredBlobs(decoder, 'k', 5, 2, async () => true, {}, whole)).to.deep.equal({
			tie: true,
			repairTargets: null,
		});
	});

	it('reports a durable tie without probing for repair', async () => {
		const decoder = countingDecoder(() => ({ version: 5, nodeId: 2, value: { x: blobA } }));
		const probe = countingProbe(true);
		expect(await resolveCopyFrameStoredBlobs(decoder, 'k', 5, 2, probe, {}, whole)).to.deep.equal({
			tie: true,
			repairTargets: null,
		});
		expect(probe.calls).to.equal(0);
	});

	it('probes and declines nothing for an absent row or a different version or node', async () => {
		const probe = countingProbe(true);
		const verify = countingProbe(false);
		const declines = {};
		const rows = [
			undefined,
			{ version: 4, nodeId: 2, value: { x: blobA } },
			{ version: 5, nodeId: 3, value: { x: blobA } },
		];
		for (const row of rows)
			expect(
				await resolveCopyFrameStoredBlobs(
					countingDecoder(() => row),
					'k',
					5,
					2,
					probe,
					declines,
					verify
				)
			).to.deep.equal({
				tie: false,
				repairTargets: null,
			});
		expect(probe.calls + verify.calls).to.equal(0);
		expect(declines).to.deep.equal({});
	});

	it('still repairs after any number of absent rows', async () => {
		const damaged = { version: 5, nodeId: 2, value: { x: blobA } };
		const decoder = countingDecoder((id) => (id === 'k' ? damaged : undefined));
		const declines = {};
		for (let i = 0; i < 20; i++)
			await resolveCopyFrameStoredBlobs(decoder, 'absent' + i, 5, 2, async () => true, declines, torn);
		expect(await resolveCopyFrameStoredBlobs(decoder, 'k', 5, 2, async () => true, declines, torn)).to.deep.equal({
			tie: false,
			repairTargets: [blobA],
		});
	});

	it('counts a throwing or rejected read and lets the record flow', async () => {
		const declines = {};
		const throwing = {
			getEntry() {
				throw new Error('decode surprise');
			},
		};
		const rejecting = { getEntry: () => Promise.reject(new Error('cold read fault')) };
		for (const decoder of [throwing, rejecting])
			expect(await resolveCopyFrameStoredBlobs(decoder, 'k', 5, 2, async () => true, declines, torn)).to.deep.equal({
				tie: false,
				repairTargets: null,
			});
		expect(declines).to.deep.equal({ 'entry-read-error': 2 });
	});
});
