import { threadId } from 'node:worker_threads';

export class IsolatedProbe extends Resource {
	get() {
		return { threadId };
	}
}
