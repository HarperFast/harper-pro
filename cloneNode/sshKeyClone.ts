import { setTimeout as sleep } from 'node:timers/promises';

export const LEADER_REQUEST_ATTEMPTS = 3;
export const LEADER_RETRY_DELAY_MS = 250;

/**
 * Key by key, since a leader can hold keys stored before `add_ssh_key` validated them, and one this node
 * refuses must not cost the rest: that refusal is skipped, logged by name and never with the key's
 * material. Anything else throws, so the clone's setup stays unfinished and a later start retries it: a
 * leader request that still fails after `attempts` tries, or a key this node can't store. A key an earlier
 * attempt already cloned is left as it is.
 */
export async function cloneSSHKeysFromLeader({
	requestLeader,
	addSSHKey,
	listLocalSSHKeys,
	log,
	attempts = LEADER_REQUEST_ATTEMPTS,
	retryDelayMs = LEADER_RETRY_DELAY_MS,
}: {
	requestLeader: (operation: { operation: string; name?: string }) => Promise<any>;
	addSSHKey: (key: any) => Promise<unknown>;
	listLocalSSHKeys: () => Promise<Array<{ name: string }>>;
	log: (message: string, level?: 'notify' | 'error') => void;
	attempts?: number;
	retryDelayMs?: number;
}): Promise<void> {
	const fromLeader = async (operation: { operation: string; name?: string }) => {
		for (let attempt = 1; ; attempt++) {
			try {
				return await requestLeader(operation);
			} catch (error) {
				if (attempt >= attempts) {
					const what = operation.name ? `${operation.operation} '${operation.name}'` : operation.operation;
					throw new Error(`${what} failed on the leader ${attempts} times: ${(error as Error)?.message ?? error}`, {
						cause: error,
					});
				}
				await sleep(retryDelayMs);
			}
		}
	};

	const keys: Array<{ name: string }> = await fromLeader({ operation: 'list_ssh_keys' });
	if (!keys?.length) {
		log('No SSH keys found on leader node to clone');
		return;
	}

	const localNames = new Set((await listLocalSSHKeys()).map(({ name }) => name));
	for (const { name } of keys) {
		if (localNames.has(name)) {
			log(`SSH key '${name}' is already on this node`);
			continue;
		}
		log(`Cloning SSH key: ${name}`);
		const key = await fromLeader({ operation: 'get_ssh_key', name });
		try {
			await addSSHKey(key);
		} catch (error) {
			const statusCode = (error as { statusCode?: number })?.statusCode ?? 0;
			if (!(statusCode >= 400 && statusCode < 500)) {
				throw new Error(`Unable to store SSH key '${name}' cloned from the leader: ${(error as Error)?.message}`, {
					cause: error,
				});
			}
			log(`Skipped cloning SSH key '${name}': ${(error as Error).message}`, 'error');
		}
	}
}
