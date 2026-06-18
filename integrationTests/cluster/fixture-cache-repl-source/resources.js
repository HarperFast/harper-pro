/**
 * Fixture component for cacheReplicationSource.test.mjs.
 *
 * Defines a `sourcedFrom` cache table whose origin is an external HTTP server
 * (controlled by the test process) whose URL is injected via
 * HARPER_TEST_ORIGIN_URL. Each cache miss POSTs to the origin with the
 * record id; the origin counts calls per-node and returns a deterministic value.
 *
 * The `replicationSource: true` option declares that only the designated
 * replication-source node should perform origin fetches; peers receive the
 * cache entry via replication rather than fetching origin themselves.
 */

const ORIGIN_URL = process.env.HARPER_TEST_ORIGIN_URL;

if (!ORIGIN_URL) {
	console.warn('[cache-repl-source fixture] HARPER_TEST_ORIGIN_URL not set — origin tracking disabled');
}

class OriginSource extends Resource {
	async get() {
		const id = this.getId();
		const nodeName = server?.hostname ?? 'unknown';

		if (!ORIGIN_URL) {
			return { id, value: `data-for-${id}`, fetchedBy: nodeName };
		}

		// POST to the mock origin server so it can track which node triggered the fetch.
		const response = await fetch(`${ORIGIN_URL}/fetch`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id, node: nodeName }),
		});
		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Mock origin returned ${response.status}: ${text}`);
		}
		const data = await response.json();
		return { id, value: data.value, fetchedBy: nodeName };
	}
}

// replicationSource: true declares that origin fetches should be routed to the
// designated replication-source node rather than executed locally on the
// requesting node. Cached entries then replicate to all peers normally.
tables.OriginCache.sourcedFrom(OriginSource, { replicationSource: true });
