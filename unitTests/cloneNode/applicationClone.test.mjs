import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { cloneFilesystemOnlyApplications, streamsPackages } from '#src/cloneNode/applicationClone';

const filesystemOnly = (name) => ({ name, entries: [] });

function harness({
	listing,
	failListing,
	failPackage = [],
	failPrepare = [],
	streamed = false,
	transfer = { withNodeModules: true },
	failTransfer,
	transientFailures = {},
} = {}) {
	const remaining = { ...transientFailures };
	const transient = (key) => {
		if (!(remaining[key] > 0)) return false;
		remaining[key]--;
		return true;
	};
	const requested = [];
	const transfers = [];
	const prepared = [];
	const logged = [];
	const archives = [];
	let transferChoices = 0;
	return {
		requested,
		transfers,
		prepared,
		archives,
		logged,
		transferChoices: () => transferChoices,
		errors: () => logged.filter(({ level }) => level === 'error').map(({ message }) => message),
		run: () =>
			cloneFilesystemOnlyApplications({
				listComponents: async () => {
					if (failListing || transient('get_components')) {
						throw new Error('Leader request failed: 503 Service Unavailable');
					}
					return listing;
				},
				chooseTransfer: async () => {
					transferChoices++;
					if (failTransfer) throw new Error(failTransfer);
					return transfer;
				},
				requestPackage: async (name, withNodeModules) => {
					requested.push(name);
					transfers.push(withNodeModules);
					if (failPackage.includes(name)) throw new Error(`Unable to locate project '${name}'`);
					if (transient(name)) throw new Error('read ECONNRESET');
					if (!streamed) return `payload:${name}`;
					const archive = Readable.from([Buffer.from(name)]);
					archives.push(archive);
					return archive;
				},
				prepareApplication: async (name, payload) => {
					if (failPrepare.includes(name)) throw new Error(`Failed to install dependencies for ${name}`);
					prepared.push({ name, payload: payload instanceof Readable ? 'archive' : payload });
				},
				log: (message, level) => logged.push({ message, level }),
				retryDelayMs: 0,
			}),
	};
}

describe('cloneFilesystemOnlyApplications', () => {
	it('prepares each filesystem-only application from the payload the leader packaged', async () => {
		const clone = harness({ listing: { entries: [filesystemOnly('first'), filesystemOnly('second')] } });
		await clone.run();

		assert.deepEqual(clone.prepared, [
			{ name: 'first', payload: 'payload:first' },
			{ name: 'second', payload: 'payload:second' },
		]);
		assert.deepEqual(clone.errors(), []);
	});

	it('leaves applications its config reinstalls, and files, alone', async () => {
		const clone = harness({
			listing: {
				entries: [
					filesystemOnly('app'),
					{ name: 'config-app', entries: [], package: 'HarperFast/application-template' },
					{ name: 'README.md', size: 3 },
				],
			},
		});
		await clone.run();

		assert.deepEqual(clone.requested, ['app']);
	});

	it('skips dot-prefixed directories, which the loader never loads', async () => {
		const clone = harness({
			listing: { entries: [filesystemOnly('.git'), filesystemOnly('.deploy-aside'), filesystemOnly('app')] },
		});
		await clone.run();

		assert.deepEqual(clone.requested, ['app']);
		assert.deepEqual(clone.errors(), []);
	});

	it('clones nothing, and does not throw, when the leader has no filesystem-only application', async () => {
		const clone = harness({ listing: { entries: [] } });
		await clone.run();

		assert.deepEqual(clone.requested, []);
	});

	it('attempts every application, then throws naming each one that failed', async () => {
		const clone = harness({
			listing: { entries: [filesystemOnly('first'), filesystemOnly('second'), filesystemOnly('third')] },
			failPackage: ['first'],
			failPrepare: ['third'],
		});
		await assert.rejects(clone.run(), {
			name: 'ApplicationCloneError',
			message: 'Failed to clone 2 of 3 filesystem-only application(s) from the leader: first, third',
		});

		assert.deepEqual(clone.requested, ['first', 'first', 'first', 'second', 'third', 'third', 'third']);
		assert.deepEqual(
			clone.prepared.map(({ name }) => name),
			['second']
		);
		assert.deepEqual(clone.errors(), [
			"Failed to clone application 'first': Error: Unable to locate project 'first'",
			"Failed to clone application 'third': Error: Failed to install dependencies for third",
		]);
	});

	it('throws when the leader cannot list its applications', async () => {
		const clone = harness({ failListing: true });
		await assert.rejects(clone.run(), {
			name: 'ApplicationCloneError',
			message: "Unable to list the leader's applications: Leader request failed: 503 Service Unavailable",
		});
		assert.deepEqual(clone.requested, []);
	});

	it('throws when the leader answers that it could not read its applications', async () => {
		const clone = harness({ listing: { error: 'Error: EACCES: permission denied, scandir', entries: [] } });
		await assert.rejects(clone.run(), {
			name: 'ApplicationCloneError',
			message: "Unable to list the leader's applications: Error: EACCES: permission denied, scandir",
		});
	});

	it('throws when the listing has no entries', async () => {
		const clone = harness({ listing: { requestId: 1 } });
		await assert.rejects(clone.run(), {
			name: 'ApplicationCloneError',
			message: "Unable to list the leader's applications: its answer has no entries",
		});
	});

	it('refuses an application listed under a name that is not a directory name', async () => {
		const clone = harness({ listing: { entries: [filesystemOnly('../escape'), filesystemOnly('app')] } });
		await assert.rejects(clone.run(), {
			name: 'ApplicationCloneError',
			message: 'Failed to clone 1 of 2 filesystem-only application(s) from the leader: ../escape',
		});

		assert.deepEqual(clone.requested, ['app']);
	});

	it('refuses, without requesting, a name package_component would shorten or reject', async () => {
		const clone = harness({
			listing: { entries: [filesystemOnly('app'), filesystemOnly('app.v2'), filesystemOnly('my app')] },
		});
		await assert.rejects(clone.run(), {
			name: 'ApplicationCloneError',
			message: 'Failed to clone 2 of 3 filesystem-only application(s) from the leader: app.v2, my app',
		});

		assert.deepEqual(clone.requested, ['app']);
		assert.match(clone.errors()[0], /'app\.v2'.*rename it on the leader/);
	});

	it('releases every archive, read or not', async () => {
		const clone = harness({
			listing: { entries: [filesystemOnly('first'), filesystemOnly('second')] },
			failPrepare: ['first'],
			streamed: true,
		});
		await assert.rejects(clone.run());

		assert.equal(clone.archives.length, 4);
		assert.ok(
			clone.archives.every((archive) => archive.destroyed),
			'an archive preparation never read must not stay open'
		);
	});

	it('chooses the transfer once and asks for every application with it', async () => {
		const clone = harness({ listing: { entries: [filesystemOnly('first'), filesystemOnly('second')] } });
		await clone.run();

		assert.equal(clone.transferChoices(), 1);
		assert.deepEqual(clone.transfers, [true, true]);
		assert.ok(!clone.logged.some(({ message }) => message.includes('instead of copying node_modules')));
	});

	it('says once why it reinstalls dependencies when the leader cannot send node_modules', async () => {
		const clone = harness({
			listing: { entries: [filesystemOnly('first'), filesystemOnly('second')] },
			transfer: { withNodeModules: false, reason: 'leader 4.7.41 cannot stream it' },
		});
		await clone.run();

		assert.deepEqual(clone.transfers, [false, false]);
		const explained = clone.logged.filter(({ message }) => message.includes('instead of copying node_modules'));
		assert.equal(explained.length, 1);
		assert.match(explained[0].message, /leader 4\.7\.41 cannot stream it/);
	});

	it('does not probe the leader when it has no filesystem-only application', async () => {
		const clone = harness({ listing: { entries: [{ name: 'config-app', entries: [], package: 'pkg' }] } });
		await clone.run();

		assert.equal(clone.transferChoices(), 0);
	});

	it('retries an application after a transient leader error', async () => {
		const clone = harness({ listing: { entries: [filesystemOnly('app')] }, transientFailures: { app: 2 } });
		await clone.run();

		assert.deepEqual(clone.requested, ['app', 'app', 'app']);
		assert.deepEqual(
			clone.prepared.map(({ name }) => name),
			['app']
		);
		assert.deepEqual(clone.errors(), []);
	});

	it('retries the listing after a transient leader error', async () => {
		const clone = harness({
			listing: { entries: [filesystemOnly('app')] },
			transientFailures: { get_components: 2 },
		});
		await clone.run();

		assert.deepEqual(clone.requested, ['app']);
	});

	it('stops before copying anything when it cannot choose the transfer', async () => {
		const clone = harness({
			listing: { entries: [filesystemOnly('app')] },
			failTransfer: 'the leader did not report its version',
		});
		await assert.rejects(clone.run(), {
			name: 'ApplicationCloneError',
			message: "Unable to choose how to copy the leader's applications: the leader did not report its version",
		});
		assert.deepEqual(clone.requested, []);
	});
});

describe('streamsPackages', () => {
	for (const [version, expected] of [
		['4.7.41', false],
		['5.1.22', false],
		['5.2.2', false],
		['5.2.3-beta.1', false],
		['5.2.3', true],
		['v5.2.3', true],
		['5.2.15', true],
		['5.3.0-alpha.1', true],
		['5.3.0', true],
		['5.10.0', true],
		['6.0.0', true],
		[undefined, undefined],
		['', undefined],
		['unknown', undefined],
		['4.3', undefined],
	]) {
		it(`reads ${JSON.stringify(version)} as ${expected}`, () => {
			assert.equal(streamsPackages(version), expected);
		});
	}
});
