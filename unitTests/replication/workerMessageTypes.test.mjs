/**
 * Contract check (harper-pro#328): manageThreads dispatches worker messages by type and ignores
 * unknown types, so a postMessage type with no registered handler is silently dropped — no error,
 * no log. This scans subscriptionManager.ts and asserts every message type it posts has a matching
 * onMessageByType registration in the same file.
 */

import { expect } from 'chai';
import { readFileSync } from 'node:fs';

// 'cluster-status' is a direct reply posted back over the requesting port (requestClusterStatus);
// the requester awaits it inline rather than registering an onMessageByType handler here.
const REPLY_TYPES = new Set(['cluster-status']);

describe('subscriptionManager worker message types', () => {
	const source = readFileSync(new URL('../../replication/subscriptionManager.ts', import.meta.url), 'utf8');

	it('every posted message type has a registered onMessageByType handler', () => {
		// message payloads are built as object literals with a `type: '...'` property, sometimes
		// assigned to a variable before being posted — so collect every type literal in the file
		const postedTypes = [...source.matchAll(/\btype: '([a-z-]+)'/g)].map((match) => match[1]);
		const handledTypes = new Set([...source.matchAll(/onMessageByType\('([a-z-]+)'/g)].map((match) => match[1]));

		expect(postedTypes).to.not.be.empty;
		expect(handledTypes).to.not.be.empty;
		const unhandled = postedTypes.filter((type) => !handledTypes.has(type) && !REPLY_TYPES.has(type));
		expect(unhandled, `posted message types with no registered handler: ${unhandled.join(', ')}`).to.be.empty;
	});
});
