/**
 * A node joining a region grid (harper-pro#1343) by base copy. Lanes are ranked by name, so the joiner is given a name
 * that sorts second in its region: it takes that lane, the two nodes after it move one lane up, and the last one lands
 * in a column the other regions have no node in, which they fold onto their first node. Every moved node then
 * subscribes directly to origins it had taken through a region-mate, and stops subscribing to others.
 *
 * The join must cost one base copy into the joiner and the copy each peer that subscribes to the joiner takes from
 * it, and nothing more: a link that becomes direct resumes from the position of the supplier it replaces, and no node
 * downstream of a copy is forced into one.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getNextAvailableLoopbackAddress } from '@harperfast/integration-testing';
import { stopAndTeardownNodes, readLogSince } from './clusterShared.mjs';
import {
	REGIONS,
	startNode,
	connectTo,
	waitForLinks,
	waitForCopiesSettled,
	insert,
	waitForPhase,
	waitForSuppliers,
	markAll,
	regionLayout,
} from './regionTopologyShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const OPTIONS = { replicationLogLevel: 'info' };
const FORCED_COPY = /Peer (\S+) requested replication of database data\b[^\n]*forcing a bounded base-copy resync/g;
const REQUESTED_COPY = /Requesting full copy of database data from (\S+)/g;

suite('A node joining a region grid', { timeout: 1_200_000 }, (ctx) => {
	let workDir;
	const contexts = [];
	const nodes = () => contexts.map((context) => context.harper);
	let joinerName;
	let before9;
	let after10;

	before(async () => {
		workDir = await mkdtemp(join(tmpdir(), 'region-join-'));
		const hostnames = [];
		for (let i = 0; i < 10; i++) hostnames.push(await getNextAvailableLoopbackAddress());
		hostnames.sort();
		joinerName = hostnames[1];
		const initial = hostnames.filter((name) => name !== joinerName);
		const regionOf = new Map(initial.map((name, index) => [name, REGIONS[Math.floor(index / 3)]]));
		before9 = regionLayout(initial, nodes, regionOf);
		after10 = regionLayout(hostnames, nodes, new Map([...regionOf, [joinerName, REGIONS[0]]]));
		const started = await Promise.allSettled(
			initial.map((name) => startNode(ctx.name, name, regionOf.get(name), workDir, OPTIONS))
		);
		for (const result of started) if (result.status === 'fulfilled') contexts.push(result.value);
		const failed = started.find((result) => result.status === 'rejected');
		if (failed) throw failed.reason;
		contexts.sort((a, b) => (a.harper.hostname < b.harper.hostname ? -1 : 1));
		await connectTo(nodes()[0], nodes());
		await waitForLinks(nodes(), before9.expectedLinks, 'grid links before the join');
		await waitForCopiesSettled(nodes(), 'formation copies');
		await waitForSuppliers(nodes(), before9.steadySuppliers(), 'settled suppliers before the join');
	});

	after(async () => {
		await stopAndTeardownNodes(nodes());
		if (workDir) await rm(workDir, { recursive: true, force: true });
	});

	test('costs no base copy beyond the joiner and loses nothing as lanes move', async () => {
		const existing = nodes();
		// one writer per column, so every link that becomes direct in the join carries an origin that has written
		const writers = [before9.named('east', 0), before9.named('west', 1), before9.named('eu', 2)];
		for (const writer of writers) await insert(writer, `before-join-${writer.hostname}`, writer.hostname, 20);
		for (const writer of writers) await waitForPhase(existing, `before-join-${writer.hostname}`, 20);
		const marks = await markAll(existing);

		contexts.push(await startNode(ctx.name, joinerName, REGIONS[0], workDir, OPTIONS));
		const joiner = contexts.at(-1).harper;
		await connectTo(existing[0], [joiner]);
		// rows written while the links move must arrive too
		for (const writer of writers) await insert(writer, `during-join-${writer.hostname}`, writer.hostname, 20);

		await waitForLinks(nodes(), after10.expectedLinks, 'grid links after the join');
		await waitForCopiesSettled(nodes(), 'copies of the join');
		await waitForSuppliers(nodes(), after10.steadySuppliers(), 'settled suppliers after the join');
		for (const writer of writers) {
			await waitForPhase(nodes(), `before-join-${writer.hostname}`, 20);
			await waitForPhase(nodes(), `during-join-${writer.hostname}`, 20);
		}
		for (const writer of [joiner, ...writers]) {
			await insert(writer, `after-join-${writer.hostname}`, writer.hostname, 20);
			await waitForPhase(nodes(), `after-join-${writer.hostname}`, 20);
		}

		for (const node of existing) {
			const log = await readLogSince(node, marks.get(node.hostname));
			for (const [line, peer] of log.matchAll(FORCED_COPY))
				assert.equal(peer, joiner.hostname, `${node.hostname} forced a base copy on a node that did not join: ${line}`);
			for (const [line, source] of log.matchAll(REQUESTED_COPY))
				assert.equal(
					URL.parse(source)?.hostname,
					joiner.hostname,
					`${node.hostname} asked a node that did not join for a base copy: ${line}`
				);
		}
	});
});
