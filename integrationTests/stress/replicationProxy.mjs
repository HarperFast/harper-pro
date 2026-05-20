/**
 * Controllable TCP proxy used by partition-tolerance tests.
 *
 * Replication on loopback can't be partitioned with iptables/tc (no NET_ADMIN,
 * loopback bypasses netfilter), so we interpose a userspace proxy between two
 * Harper nodes and toggle it from the test to simulate a network partition.
 *
 * Usage:
 *   const proxy = new ReplicationProxy({ listenHost, listenPort, targetHost, targetPort });
 *   await proxy.start();
 *   // ... later in the test:
 *   proxy.block();   // close existing connections, drop new ones until unblocked
 *   proxy.unblock(); // accept again
 *   await proxy.stop();
 *
 * Connection semantics while blocked:
 *  - existing client sockets are destroyed (forces both ends to notice
 *    the partition immediately rather than waiting on a keepalive)
 *  - new incoming sockets are accepted-then-destroyed, so the client sees
 *    a fast connect-then-close (more "drop-y" than refused)
 *
 * No TLS termination — Harper's replication socket is already encrypted by
 * Harper. The proxy is purely a TCP pipe.
 */

import { createServer, connect } from 'node:net';

export class ReplicationProxy {
	constructor({ listenHost, listenPort, targetHost, targetPort }) {
		this.listenHost = listenHost;
		this.listenPort = listenPort;
		this.targetHost = targetHost;
		this.targetPort = targetPort;
		this.blocked = false;
		this.connections = new Set();
		this.server = null;
	}

	start() {
		return new Promise((resolve, reject) => {
			this.server = createServer((clientSocket) => {
				if (this.blocked) {
					clientSocket.destroy();
					return;
				}
				const upstream = connect({ host: this.targetHost, port: this.targetPort });
				const pair = { clientSocket, upstream, cleaned: false };
				this.connections.add(pair);
				const cleanup = () => {
					// Both sockets emit 'close' after the first .destroy(); guard so
					// we only tear down once per pair instead of fanning out.
					if (pair.cleaned) return;
					pair.cleaned = true;
					this.connections.delete(pair);
					clientSocket.destroy();
					upstream.destroy();
				};
				clientSocket.on('error', cleanup);
				upstream.on('error', cleanup);
				clientSocket.on('close', cleanup);
				upstream.on('close', cleanup);
				clientSocket.pipe(upstream);
				upstream.pipe(clientSocket);
			});
			this.server.on('error', reject);
			this.server.listen(this.listenPort, this.listenHost, () => resolve());
		});
	}

	block() {
		this.blocked = true;
		for (const pair of this.connections) {
			pair.clientSocket.destroy();
			pair.upstream.destroy();
		}
		this.connections.clear();
	}

	unblock() {
		this.blocked = false;
	}

	stop() {
		this.block();
		return new Promise((resolve) => {
			if (!this.server) return resolve();
			this.server.close(() => resolve());
		});
	}
}
