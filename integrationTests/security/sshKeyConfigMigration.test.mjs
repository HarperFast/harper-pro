/**
 * A node upgraded from a version that wrote SSH config blocks with only a `#name` line gets BEGIN and END
 * lines around them while it starts, before it answers any operation, and the SSH key operations then
 * read and delete through those lines.
 */
import { suite, test, before, after } from 'node:test';
import { equal, deepEqual, match } from 'node:assert';
import { generateKeyPairSync } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startHarper, killHarper, teardownHarper } from '@harperfast/integration-testing';
import { sendOperation } from '../cluster/clusterShared.mjs';

process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');

const UNMANAGED = 'Host other\n\tHostName other.example.com';

function makeKey() {
	return generateKeyPairSync('ec', {
		namedCurve: 'P-256',
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'sec1', format: 'pem' },
	}).privateKey;
}

suite('SSH config written before key blocks had BEGIN and END lines', (ctx) => {
	before(async () => {
		await startHarper(ctx);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('gets them when the node starts, and is read and deleted through them', async () => {
		const configFile = join(ctx.harper.dataRootDir, 'ssh', 'config');
		for (const name of ['first', 'second']) {
			await sendOperation(ctx.harper, {
				operation: 'add_ssh_key',
				name,
				key: makeKey(),
				host: `${name}.alias`,
				hostname: 'git.example.com',
			});
		}
		const marked = await readFile(configFile, 'utf8');
		match(
			marked,
			/^#first\n# BEGIN harper ssh key first\nHost first\.alias\n[^]*\n# END harper ssh key first\n#second\n/
		);

		// stopped, and started again on a config an earlier version wrote for the same keys, with a section of
		// the user's own after them
		await killHarper(ctx);
		await writeFile(
			configFile,
			`${marked.replace(/^# (BEGIN|END) harper ssh key .*\n?/gm, '').trimEnd()}\n${UNMANAGED}`
		);
		await startHarper(ctx);

		equal(await readFile(configFile, 'utf8'), `${marked}\n${UNMANAGED}`);
		deepEqual(
			(await sendOperation(ctx.harper, { operation: 'list_ssh_keys' })).sort((a, b) => a.name.localeCompare(b.name)),
			[
				{ name: 'first', host: 'first.alias', hostname: 'git.example.com' },
				{ name: 'second', host: 'second.alias', hostname: 'git.example.com' },
			]
		);
		await sendOperation(ctx.harper, { operation: 'delete_ssh_key', name: 'first' });
		equal(await readFile(configFile, 'utf8'), `${marked.slice(marked.indexOf('#second\n'))}\n${UNMANAGED}`);
	});
});
