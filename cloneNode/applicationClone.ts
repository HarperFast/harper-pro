import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { PROJECT_NAME_PATTERN } from '../core/utility/componentNames.ts';

export class ApplicationCloneError extends Error {
	name = 'ApplicationCloneError';
}

/**
 * Whether a leader can package an application's node_modules without its own Harper install. From 5.3.0
 * the packer leaves out the loader's `node_modules/harper` link; earlier leaders follow it (v4 follows
 * `node_modules/harperdb`), so every application would carry the whole install. A 5.3.0 prerelease is
 * earlier than 5.3.0, and the alphas lack the exclusion.
 */
export function packagesNodeModulesWithoutInstall(leaderVersion: string | undefined): boolean {
	const [, major, minor, patch, prerelease] = /(\d+)\.(\d+)(?:\.(\d+)(-\S+)?)?/.exec(leaderVersion ?? '') ?? [];
	if (major === undefined) return false;
	if (Number(major) !== 5) return Number(major) > 5;
	if (Number(minor) !== 3) return Number(minor) > 3;
	return Number(patch ?? 0) > 0 || prerelease === undefined;
}

/**
 * Copies the leader's filesystem-only applications — those without a `package` in its config, which
 * nothing reinstalls on this node — as the leader packages them, node_modules included whenever
 * `chooseTransfer` allows: npm cannot rebuild a package whose only copy is in node_modules (a `file:`
 * dependency into it, a bundler's private workspace package), nor a deploy's request-scoped install
 * options or registry credentials.
 *
 * Every application is attempted, then any failure throws, so clone setup stops before this node can be
 * marked cloned or Available without an application the leader serves.
 */
export async function cloneFilesystemOnlyApplications({
	listComponents,
	chooseTransfer,
	requestPackage,
	prepareApplication,
	log,
}: {
	listComponents: () => Promise<any>;
	chooseTransfer: () => Promise<{ withNodeModules: boolean; reason?: string }>;
	requestPackage: (name: string, withNodeModules: boolean) => Promise<string | Readable>;
	prepareApplication: (name: string, payload: string | Readable) => Promise<unknown>;
	log: (message: string, level?: 'notify' | 'error') => void;
}): Promise<void> {
	let listing: any;
	try {
		listing = await listComponents();
	} catch (error) {
		throw new ApplicationCloneError(`Unable to list the leader's applications: ${(error as Error)?.message ?? error}`, {
			cause: error,
		});
	}
	// get_components answers a components root it could not read with `{ error, entries: [] }`, not a failure.
	if (listing?.error || !Array.isArray(listing?.entries)) {
		throw new ApplicationCloneError(
			`Unable to list the leader's applications: ${listing?.error ?? 'its answer has no entries'}`
		);
	}

	const applications = listing.entries.filter(
		(entry: any) => Array.isArray(entry?.entries) && !entry.package && !isHiddenDirectory(entry.name)
	);
	if (applications.length === 0) {
		log('No filesystem-only applications found on leader to clone');
		return;
	}
	log(`Cloning ${applications.length} application(s) not referenced in harper-config`);
	let transfer: { withNodeModules: boolean; reason?: string };
	try {
		transfer = await chooseTransfer();
	} catch (error) {
		throw new ApplicationCloneError(
			`Unable to choose how to copy the leader's applications: ${(error as Error)?.message ?? error}`,
			{ cause: error }
		);
	}
	const { withNodeModules, reason } = transfer;
	if (!withNodeModules) {
		log(
			`Reinstalling each application's dependencies with npm instead of copying node_modules (${reason}); a package that exists only in an application's node_modules will be missing`
		);
	}

	const failed: string[] = [];
	for (const { name } of applications) {
		log(`Cloning application: ${name}`);
		let payload: string | Readable | undefined;
		try {
			if (!isComponentName(name)) throw new Error('the leader listed it under a name that is not a directory name');
			// package_component cuts `app.v2` down to `app`, so the request would return a different application.
			if (!PROJECT_NAME_PATTERN.test(name)) {
				throw new Error(
					`package_component cannot fetch it by that name; rename it on the leader to letters, digits, '-' and '_' only`
				);
			}
			payload = await requestPackage(name, withNodeModules);
			await prepareApplication(name, payload);
			log(`Successfully cloned application: ${name}`);
		} catch (error) {
			log(`Failed to clone application '${name}': ${error}`, 'error');
			failed.push(name);
		} finally {
			// An archive that preparation never read would otherwise hold the leader's response open.
			if (payload instanceof Readable) payload.destroy();
		}
	}
	if (failed.length > 0) {
		throw new ApplicationCloneError(
			`Failed to clone ${failed.length} of ${applications.length} filesystem-only application(s) from the leader: ${failed.join(', ')}`
		);
	}
}

// The loader never loads a dot-prefixed directory (`.git`, editor state, Harper's own staging), and
// package_component refuses the name. A malformed name such as `../escape` is not hidden: it is refused.
function isHiddenDirectory(name: unknown): boolean {
	return isComponentName(name) && name.startsWith('.');
}

function isComponentName(name: unknown): name is string {
	return typeof name === 'string' && name !== '.' && name !== '..' && name !== '' && basename(name) === name;
}
