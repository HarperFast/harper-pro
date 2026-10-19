import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { gte, valid } from 'semver';
import { PROJECT_NAME_PATTERN } from '../core/utility/componentNames.ts';
import { LEADER_REQUEST_ATTEMPTS, LEADER_RETRY_DELAY_MS } from './sshKeyClone.ts';

export class ApplicationCloneError extends Error {
	name = 'ApplicationCloneError';
}

type Transfer = { withNodeModules: true } | { withNodeModules: false; reason: string };

/**
 * `package_component` streams from 5.2.3 (see cloneNode/DESIGN.md for why that decides the transfer);
 * undefined when the version is not semver.
 */
export function streamsPackages(leaderVersion: string | undefined): boolean | undefined {
	const parsed = valid(leaderVersion ?? '');
	return parsed === null ? undefined : gte(parsed, '5.2.3');
}

/**
 * Copies the leader's filesystem-only applications (see cloneNode/DESIGN.md). A failure throws only after
 * every application was attempted, so the log names all of them.
 */
export async function cloneFilesystemOnlyApplications({
	listComponents,
	chooseTransfer,
	requestPackage,
	prepareApplication,
	log,
	attempts = LEADER_REQUEST_ATTEMPTS,
	retryDelayMs = LEADER_RETRY_DELAY_MS,
}: {
	listComponents: () => Promise<any>;
	chooseTransfer: () => Promise<Transfer>;
	requestPackage: (name: string, withNodeModules: boolean) => Promise<string | Readable>;
	prepareApplication: (name: string, payload: string | Readable) => Promise<unknown>;
	log: (message: string, level?: 'notify' | 'error') => void;
	attempts?: number;
	retryDelayMs?: number;
}): Promise<void> {
	const retried = async <T>(what: string, operation: () => Promise<T>): Promise<T> => {
		for (let attempt = 1; ; attempt++) {
			try {
				return await operation();
			} catch (error) {
				if (attempt >= attempts) throw error;
				log(`${what} failed (attempt ${attempt}/${attempts}), retrying: ${error}`);
				await sleep(retryDelayMs);
			}
		}
	};
	let listing: any;
	try {
		listing = await retried("Listing the leader's applications", listComponents);
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
	let transfer: Transfer;
	try {
		transfer = await chooseTransfer();
	} catch (error) {
		throw new ApplicationCloneError(
			`Unable to choose how to copy the leader's applications: ${(error as Error)?.message ?? error}`,
			{ cause: error }
		);
	}
	const { withNodeModules } = transfer;
	if ('reason' in transfer) {
		log(
			`Reinstalling each application's dependencies with npm instead of copying node_modules (${transfer.reason}); a package that exists only in an application's node_modules will be missing`
		);
	}

	const failed: string[] = [];
	for (const { name } of applications) {
		log(`Cloning application: ${name}`);
		try {
			if (!isComponentName(name)) throw new Error('the leader listed it under a name that is not a directory name');
			// package_component cuts `app.v2` down to `app`, so the request would return a different application.
			if (!PROJECT_NAME_PATTERN.test(name)) {
				throw new Error(
					`package_component cannot fetch it by that name; rename it on the leader to letters, digits, '-' and '_' only`
				);
			}
			await retried(`Cloning application '${name}'`, async () => {
				const payload = await requestPackage(name, withNodeModules);
				try {
					await prepareApplication(name, payload);
				} finally {
					// An archive that preparation never read would otherwise hold the leader's response open.
					if (payload instanceof Readable) payload.destroy();
				}
			});
			log(`Successfully cloned application: ${name}`);
		} catch (error) {
			log(`Failed to clone application '${name}': ${error}`, 'error');
			failed.push(name);
		}
	}
	if (failed.length > 0) {
		throw new ApplicationCloneError(
			`Failed to clone ${failed.length} of ${applications.length} filesystem-only application(s) from the leader: ${failed.join(', ')}`
		);
	}
}

// The loader never loads a dot-prefixed directory (`.git`, editor state, Harper's own staging), and
// package_component refuses the name.
function isHiddenDirectory(name: unknown): boolean {
	return isComponentName(name) && name.startsWith('.');
}

function isComponentName(name: unknown): name is string {
	return typeof name === 'string' && name !== '.' && name !== '..' && name !== '' && basename(name) === name;
}
