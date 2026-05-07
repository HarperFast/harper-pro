import { createECDH } from 'node:crypto';
import { spawn } from 'node:child_process';

export class CpuWork extends Resource {
	static loadAsInstance = false;

	async post(query, data) {
		if (data?.doExpensiveComputation) {
			for (let i = 0; i < 1000; i++) {
				doExpensiveThing();
			}
		}
		if (data?.spawnChildren) {
			const children = [];
			for (let i = 0; i < 3; i++) {
				const child = spawn('node', ['-e', 'const s = Date.now(); while (Date.now() - s < 200) {}']);
				children.push(child);
			}
			await Promise.all(children.map((child) => new Promise((resolve) => child.on('exit', resolve))));
		}
	}
}

function doExpensiveThing() {
	const ecdh = createECDH('secp256k1');
	ecdh.generateKeys();
}
