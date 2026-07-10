#!/usr/bin/env node

'use strict';

process.env.HARPER_BUILTIN_COMPONENTS =
	(process.env.HARPER_BUILTIN_COMPONENTS ? process.env.HARPER_BUILTIN_COMPONENTS + ',' : '') +
	'replication=@/dist/replication/replicator.js,license=@/dist/licensing/usageLicensing.js,analytics=@/dist/analytics/profile.js,secretCustody=@/dist/security/keyCustody.js';

import { parseArgs } from 'node:util';

const { values } = parseArgs({
	options: {
		'leader-url': { type: 'string' },
		'rootpath': { type: 'string' },
	},
	strict: false, // Allow other args to be passed through
});
// harper-pro#530: read + close the injected secrets-key fd as the first thing in boot, before
// cloneNode/harper() spawn any worker thread or subprocess. The entrypoint opens fd 3 without
// close-on-exec, so until we close it every descendant that shares the fd table could read the
// cluster private key off /proc/self/fd/3. custodyState is dependency-free (node:fs only), so this
// pulls in nothing that reads config before the base path is set. The read is idempotent — the
// secretCustody component later retrieves the same cached PEM.
require('../security/custodyState.js').consumeInjectedKeyMaterial();

const HDB_LEADER_URL = values['leader-url'] || process.env.HDB_LEADER_URL || values['HDB_LEADER_URL'];

// Check to see if extra args are passed to harper, this could be the case with api-ops through the CLI
const hasPositionalArg = Boolean(process.argv[2] && !process.argv[2].startsWith('-'));

if (HDB_LEADER_URL && !hasPositionalArg) {
	// If rootpath is provided ensure that an uppercase version of the arg is also added to process.argv so it can be picked
	// by anything expecting it in uppercase.
	if (!process.argv.includes('--ROOTPATH') && values['rootpath']) process.argv.push('--ROOTPATH', values['rootpath']);

	const { setHdbBasePath } = require('../core/utility/environment/environmentManager.js');
	if (values['rootpath']) {
		setHdbBasePath(values['rootpath']);
	}

	const { cloneNode } = require('../cloneNode/cloneNode');

	// If HDB_LEADER_URL is set, we are in a clone node scenario.
	// Clone Node will start Harper after cloning is complete. If this node is already marked as cloned,
	// it will skip the cloning process and just start Harper.
	cloneNode()
		.then((message) => {
			if (message) {
				console.log(message);
			}
		})
		.catch((error) => {
			if (error) {
				console.error(error);
			}
			process.exit(1);
		});
} else {
	const { harper } = require('../core/bin/harper');

	harper()
		.then((message) => {
			if (message) {
				console.log(message);
			}
			// Intentionally not calling `process.exit(0);` so if a CLI
			// command resulted in a long-running process (aka `run`),
			// it continues to run.
		})
		.catch((error) => {
			if (error) {
				console.error(error);
			}
			process.exit(1);
		});
}
