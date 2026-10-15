import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { cloneFilesystemOnlyApplications } from '#src/cloneNode/applicationClone';

const filesystemOnly = (name) => ({ name, entries: [] });

function harness({ listing, failListing, failPackage = [], failPrepare = [], streamed = false } = {}) {
	const requested = [];
	const prepared = [];
	const logged = [];
	const archives = [];
	return {
		requested,
		prepared,
		archives,
		errors: () => logged.filter(({ level }) => level === 'error').map(({ message }) => message),
		run: () =>
			cloneFilesystemOnlyApplications({
				listComponents: async () => {
					if (failListing) throw new Error('Leader request failed: 503 Service Unavailable');
					return listing;
				},
				requestPackage: async (name) => {
					requested.push(name);
					if (failPackage.includes(name)) throw new Error(`Unable to locate project '${name}'`);
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

		assert.deepEqual(clone.requested, ['first', 'second', 'third']);
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

	it('releases every archive, read or not', async () => {
		const clone = harness({
			listing: { entries: [filesystemOnly('first'), filesystemOnly('second')] },
			failPrepare: ['first'],
			streamed: true,
		});
		await assert.rejects(clone.run());

		assert.equal(clone.archives.length, 2);
		assert.ok(
			clone.archives.every((archive) => archive.destroyed),
			'an archive preparation never read must not stay open'
		);
	});
});
