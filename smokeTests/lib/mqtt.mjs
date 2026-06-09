/**
 * MQTT readiness probe for the acl-connect canary.
 * GET / returns 500 on this component (no HTTP root), so we gate on the MQTTS listener instead.
 */
import tls from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';

/** Resolve true if a TLS handshake to host:port succeeds within timeoutMs. */
function tlsConnects(host, port, timeoutMs = 3000) {
	return new Promise((resolve) => {
		const socket = tls.connect({ host, port, rejectUnauthorized: false, timeout: timeoutMs }, () => {
			socket.end();
			resolve(true);
		});
		socket.on('error', () => resolve(false));
		socket.on('timeout', () => {
			socket.destroy();
			resolve(false);
		});
	});
}

/** Poll the MQTTS port until it accepts a connection, or throw after tries. */
export async function waitForMqtts(host, port, { tries = 60, intervalMs = 500 } = {}) {
	for (let i = 0; i < tries; i++) {
		if (await tlsConnects(host, port)) return;
		await delay(intervalMs);
	}
	throw new Error(`Timed out waiting for MQTTS listener at ${host}:${port}`);
}
