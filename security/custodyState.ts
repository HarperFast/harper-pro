/**
 * Dependency-free clone-bootstrap flag. cloneNode sets it before starting Harper for a clone so
 * the file custody tier (keyCustody.ts) never self-generates a cluster env-secrets keypair while
 * the leader's key is still being cloned — a clone-local key would diverge the cluster and could
 * even encrypt new secrets before the real key arrives. Kept apart from fileKeyCustody so
 * cloneNode can import it pre-start without pulling in the key-store/database import graph.
 *
 * The flag is cleared only after the leader's key has been cloned and registered; if the clone
 * cannot fetch a key, custody stays dormant for the rest of the bootstrap session (fail-closed).
 */
let cloneBootstrapInProgress = false;

export function setCloneBootstrapInProgress(inProgress: boolean): void {
	cloneBootstrapInProgress = inProgress;
}

export function isCloneBootstrapInProgress(): boolean {
	return cloneBootstrapInProgress;
}
