// Some replicated/forwarded operations carry secrets — SSH private keys (add_ssh_key /
// update_ssh_key), user passwords (add_user), and auth headers — that must never reach the
// debug/trace logs emitted by the replication send/receive paths. Return a shallow copy of the
// operation with those fields masked. Only invoke this when the target log level is active so the
// copy stays off the hot path; when no sensitive field is present the original object is returned
// unchanged (no allocation), keeping the common data-replication case cheap.
//
// deploy_component registryAuth: with core's hdb_secret-backed registry auth, a provided token is
// sealed into the secrets store and only a non-secret REFERENCE ({ registry, secret, scope }) is
// replicated — those pass through un-redacted (a secret name is a pointer, not a credential). A
// literal token appears only on the no-custody transient fallback and is stripped before
// replicating, so the per-entry token mask below is defense-in-depth for any forwarding path.
const SENSITIVE_OPERATION_FIELDS = ['token', 'key', 'password', 'hdbAuthHeader'];

export function redactOperationForLog(operation: any): any {
	if (!operation || typeof operation !== 'object') return operation;
	let masked: any;
	const ensureCopy = () => {
		if (!masked) masked = { ...operation };
		return masked;
	};
	for (const field of SENSITIVE_OPERATION_FIELDS) {
		if (operation[field] !== undefined) {
			ensureCopy()[field] = '[redacted]';
		}
	}
	// registryAuth entries are normally references ({ registry, secret, scope? }) with no token —
	// left as-is. Mask a token only on the entries that carry one (transient-fallback / forwarding
	// paths), keeping the non-secret registry/scope/secret visible for debugging.
	if (Array.isArray(operation.registryAuth)) {
		let redactedAuth = false;
		const maskedAuth = operation.registryAuth.map((entry: any) => {
			if (entry && typeof entry === 'object' && 'token' in entry) {
				redactedAuth = true;
				return { ...entry, token: '[redacted]' };
			}
			return entry;
		});
		// Only allocate a copy if a token was actually present, preserving the no-allocation fast path.
		if (redactedAuth) ensureCopy().registryAuth = maskedAuth;
	}
	return masked ?? operation;
}
