/**
 * Test-only subscribe/open ordering injection for harper-pro#431.
 *
 * Holding a connection's first subscribe until its socket has opened leaves a live link whose connect
 * edge was never posted — the harper-pro#289 desync the shared-truth up-correction exists for, which
 * nothing black-box can produce because the real window is the race between the WS handshake and an
 * async subscribe(). Covered by integrationTests/cluster/truthResiduals.test.mjs R5.
 *
 * Two variables, because the arming has to be late: the process must opt in at startup, and only then
 * may the suite name a database at runtime — arming at startup instead would perturb the other cases in
 * that suite. Module state is per worker thread, so the one-shot is too.
 */
import harperLogger from '../core/utility/logging/harper_logger.js';
import type { Logger } from '../core/utility/logging/logger.ts';
const { forComponent } = harperLogger;

const logger = forComponent('replication').conditional as Logger;

/** Only a process started with this can ever arm, and the production subscribe path tests a constant. */
export const subscribeDeferralAllowedForTest = process.env.HARPER_TEST_ALLOW_SUBSCRIBE_AFTER_OPEN_HOOK === '1';

let armed = false;

/**
 * Returns true when this subscribe has been taken over and the caller must not apply it.
 * `connection` is the NodeReplicationConnection; typed loosely to keep this module off its import cycle.
 */
export function deferSubscribeUntilSessionForTest(
	connection: any,
	nodeSubscriptions: any,
	replicateTablesByDefault: boolean
): boolean {
	// Replaces rather than overtakes: applying it would post the edge this suppresses, and leave the newer
	// node set to be overwritten on release.
	if (connection.deferredSubscribeForTest) {
		connection.deferredSubscribeForTest = { nodeSubscriptions, replicateTablesByDefault };
		return true;
	}
	if (armed || connection.nodeSubscriptions !== undefined || !connection.session) return false;
	// Guard the unset variable before comparing, or a connection whose own databaseName is undefined
	// matches undefined !== undefined and burns the one-shot before the suite has named a database —
	// the same trap the wedge hook documents in replicationConnection.ts.
	const deferralDatabase = process.env.HARPER_TEST_SUBSCRIBE_AFTER_OPEN_ONCE_DB;
	if (!deferralDatabase || deferralDatabase !== connection.databaseName) return false;
	armed = true;
	connection.deferredSubscribeForTest = { nodeSubscriptions, replicateTablesByDefault };
	logger.warn?.(`[test] deferring subscribe until session open for db "${connection.databaseName}" (harper-pro#431)`);
	// liveSession, not the promise settling, is the proof a socket opened: the promise also settles on a
	// socket error. Assigned in the open handler right after replicateOverWS, which is the ordering the
	// test needs.
	const release = () => {
		const held = connection.deferredSubscribeForTest;
		if (!held) return;
		const abandoned = connection.intentionallyUnsubscribed || connection.isFinished;
		if (!abandoned && connection.liveSession === undefined) return;
		connection.deferredSubscribeForTest = undefined;
		clearInterval(retry);
		if (abandoned) return;
		logger.warn?.(`[test] releasing deferred subscribe for db "${connection.databaseName}" (harper-pro#431)`);
		// subscribeToNode() contains a throw from its own subscribe(); a promise callback would not.
		try {
			connection.subscribe(held.nodeSubscriptions, held.replicateTablesByDefault);
		} catch (error) {
			logger.error?.(`[test] deferred subscribe failed for db "${connection.databaseName}"`, error);
		}
	};
	// Release has to land in the same microtask batch as the open handler's sessionResolve, ahead of the
	// peer's first frame: the handshake's shared-truth CONNECTED stamp is gated on nodeSubscriptions, and
	// missing it leaves nothing to write CONNECTED until a pong up to a ping interval later. So follow the
	// session promise, and re-follow it whenever a failed attempt replaces it — resetSession() abandons the
	// old one (connect()'s createWebSocket rejection leaves it pending for good), so watching only the
	// first would strand the payload.
	let watched: Promise<unknown> | undefined;
	const followSession = () => {
		// Abandonment is checked here, not only in release: a connection whose every attempt fails inside
		// createWebSocket never settles a session promise, so release is not reachable to do the cleanup.
		if (connection.intentionallyUnsubscribed || connection.isFinished) connection.deferredSubscribeForTest = undefined;
		if (!connection.deferredSubscribeForTest) return clearInterval(retry);
		if (watched === connection.session) return;
		watched = connection.session;
		connection.session.then(release, release);
	};
	const retry = setInterval(followSession, 250);
	retry.unref();
	followSession();
	return true;
}
