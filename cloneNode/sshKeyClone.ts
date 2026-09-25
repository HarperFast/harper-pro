/**
 * Copies the leader's SSH keys onto this node one key at a time, so a key that can't be fetched, or
 * that this node's `add_ssh_key` refuses, costs only itself. A leader can hold keys stored before
 * `add_ssh_key` validated them, which the local add now refuses.
 *
 * @param requestLeader - sends an operation to the leader and resolves to its response.
 * @param addSSHKey - stores one key locally, as `add_ssh_key` does.
 * @param log - reports progress, and each skipped key by name (never its material).
 */
export async function cloneSSHKeysFromLeader(
	requestLeader: (operation: { operation: string; name?: string }) => Promise<any>,
	addSSHKey: (key: any) => Promise<unknown>,
	log: (message: string, level?: 'notify' | 'error') => void
): Promise<void> {
	let keys: Array<{ name: string }>;
	try {
		keys = await requestLeader({ operation: 'list_ssh_keys' });
	} catch (error) {
		log(`Error cloning SSH keys: ${error}`, 'error');
		return;
	}
	if (!keys?.length) {
		log('No SSH keys found on leader node to clone');
		return;
	}

	for (const { name } of keys) {
		log(`Cloning SSH key: ${name}`);
		try {
			await addSSHKey(await requestLeader({ operation: 'get_ssh_key', name }));
		} catch (error) {
			log(`Skipped cloning SSH key '${name}': ${(error as Error)?.message ?? error}`, 'error');
		}
	}
}
