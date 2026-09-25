export class DeployValidationPing extends Resource {
	get() {
		return { pong: true };
	}
}
