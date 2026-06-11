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
		repo: 'HarperFast/early-hints',
		ref: 'v1.1.2',
		dir: 'early-hints',
		project: 'early-hints',
	},
	// acl-connect-example bundles @harperdb/acl-connect@1.0.9 from npm; no release tags, pin to commit.
	'acl-connect': {
		repo: 'HarperFast/acl-connect-example',
		ref: 'b9779d5bcba37400f710c9c298205f753a9cef4d',
		dir: 'acl-connect-example',
		project: 'acl-connect-example',
	},
};

export const COMPONENT_NAMES = Object.keys(COMPONENTS);

const ROOT = process.env.SMOKE_COMPONENTS_ROOT || join(import.meta.dirname, '.components');

/** Absolute path to a component's checkout directory. */
export function componentDir(name) {
	const entry = COMPONENTS[name];
	if (!entry) throw new Error(`Unknown component: ${name}. Known: ${COMPONENT_NAMES.join(', ')}`);
	return join(ROOT, entry.dir);
}
