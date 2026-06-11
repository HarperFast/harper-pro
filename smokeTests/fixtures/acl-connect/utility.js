/**
 * Represents a user in the system with authentication and authorization details.
 */
export class User {
	constructor(username, clientID, authGroups) {
		this.active = true;
		this.username = username;
		this.client_id = clientID;
		this.authGroups = authGroups;
		this.role = {
			role: authGroups,
			permission: {
				super_user: false,
			},
		};
	}
}
