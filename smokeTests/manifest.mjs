/**
 * Refs the smoke suite uses to clone each component. Can be a tag, SHA, or branch.
 * Keep in sync with the workflow matrices. A red run on a branch ref (e.g. `main`) can mean
 * either Pro broke or the component changed; pin to a tag/SHA when bisectability matters.
 */
import { join } from 'node:path';

export const COMPONENTS = {
	'risk-query': {
		repo: 'HarperFast/risk-query',
		ref: 'main',
		dir: 'risk-query',
		project: 'risk-query',
	},
	'redirector': {
		repo: 'HarperFast/template-redirector',
		ref: 'main',
		dir: 'template-redirector',
		project: 'template-redirector',
	},
	'early-hints': {
		repo: 'HarperFast/template-early-hints',
		ref: 'main',
		dir: 'template-early-hints',
		project: 'template-early-hints',
	},
	// acl-connect is deployed from the vendored wrapper in smokeTests/fixtures/acl-connect/
	// (config + connect.json topology + JWT user mapping), which pulls the public
	// @harperdb/acl-connect library from github:HarperFast/acl-connect#main via npm. No clone.
	'acl-connect': {
		repo: 'HarperFast/acl-connect',
		ref: 'main',
		project: 'acl-connect-fixture',
		vendored: true,
		fixturePath: 'fixtures/acl-connect',
	},
};

export const COMPONENT_NAMES = Object.keys(COMPONENTS);

const ROOT = process.env.SMOKE_COMPONENTS_ROOT || join(import.meta.dirname, '.components');

/** Absolute path to a component's directory: either the cloned checkout or a vendored fixture. */
export function componentDir(name) {
	const entry = COMPONENTS[name];
	if (!entry) throw new Error(`Unknown component: ${name}. Known: ${COMPONENT_NAMES.join(', ')}`);
	if (entry.vendored) return join(import.meta.dirname, entry.fixturePath);
	return join(ROOT, entry.dir);
}
