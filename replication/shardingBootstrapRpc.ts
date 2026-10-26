export const SHARDING_BOOTSTRAP_OPERATION = '_sharding_bootstrap';
export const SHARDING_CERTIFICATE_PRINCIPAL = Symbol('shardingCertificatePrincipal');

let handler: ((request: any, member: string) => Promise<object>) | undefined;

export function setShardingBootstrapHandler(next: typeof handler): void {
	handler = next;
}

export async function receiveShardingBootstrap(request: any, principal: any): Promise<object> {
	const member = principal?.[SHARDING_CERTIFICATE_PRINCIPAL];
	if (typeof member !== 'string' || !member || principal?.name !== member || request?.from !== member)
		throw new Error('Sharding bootstrap requires this member’s authenticated node certificate');
	if (!handler) throw new Error('Sharding bootstrap is not initialized on this node');
	return handler(request, member);
}
