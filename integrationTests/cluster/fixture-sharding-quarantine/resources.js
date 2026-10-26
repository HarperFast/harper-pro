import { Resource, server } from 'harper';
import { threadId } from 'node:worker_threads';

server.http(
	async (request, next) => {
		const response = await next(request);
		response?.headers?.set('x-sharding-thread', String(threadId));
		return response;
	},
	{ runFirst: true }
);

export class ShardingWorker extends Resource {
	get() {
		return { threadId, pid: process.pid };
	}
}
