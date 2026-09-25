/**
 * Key by key, since a leader can hold keys stored before `add_ssh_key` validated them, and one this node
 * refuses must not cost the rest. A skipped key is logged by name, never with its material.
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
