/**
 * Shared helpers for the per-component smoke files.
 */
import { join } from 'node:path';

/** SCHEME/HOST/PORT/USER/PASSWORD env a canary script needs from a started node. */
export function nodeConnEnv(node) {
	const url = new URL(node.httpURL);
	return {
		SCHEME: url.protocol.replace(':', ''),
		HOST: url.hostname,
		PORT: url.port,
		USER: node.admin.username,
		PASSWORD: node.admin.password,
	};
}

/** Absolute path to a bundled k6 canary script. */
export function k6Script(name) {
	return join(import.meta.dirname, '..', 'k6', `${name}.canary.js`);
}

/** Absolute path under smokeTests/fixtures. */
export function fixture(...parts) {
	return join(import.meta.dirname, '..', 'fixtures', ...parts);
}
