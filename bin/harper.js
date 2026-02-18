#!/usr/bin/env node

'use strict';

process.env.HARPER_BUILTIN_COMPONENTS =
	(process.env.HARPER_BUILTIN_COMPONENTS ? process.env.HARPER_BUILTIN_COMPONENTS + ',' : '') +
	'replication=@/dist/replication/replicator.js';

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
