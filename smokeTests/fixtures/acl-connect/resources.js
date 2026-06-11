import jwt from 'jsonwebtoken';
import { createRequire } from 'module';
import { User } from './utility.js';

const require = createRequire(import.meta.url);
const SETTINGS = require('./connect.json');
const mqtt_log = logger;

const hdbGetUser = server.getUser;

/**
 * Custom user authentication: treats long, three-segment passwords as JWTs and
 * decodes them (no signature verification, fine for the smoke fixture). Falls
 * back to the default Harper getUser for everything else.
 */
server.getUser = async function (username, password) {
	if (password?.length > 100 && password.split('.').length === 3) {
		let decoded;
		try {
			decoded = jwt.decode(password);
		} catch (e) {
			const msg = `Error verifying token: ${e.message}. For username: ${username}, token: ${password}`;
			mqtt_log.error(msg);
			throw new Error(msg);
		}
		return new User(
			decoded[SETTINGS.options.userName] ? decoded[SETTINGS.options.userName] : username,
			decoded[SETTINGS.options.clientId],
			decoded[SETTINGS.options.authorizations]
		);
	}

	const user = await hdbGetUser(username, password);
	user.client_id = username;
	return user;
};

/**
 * MQTT connection guard: rejects anonymous connections that specify a clientId
 * or are not clean-session, and enforces clientId match against the JWT claim
 * for authenticated users.
 */
server.mqtt.authorizeClient = (connection_message, user) => {
	if (!user) {
		if (connection_message.clientId) throw new Error('Can not specify a client id');
		if (!connection_message.clean) throw new Error('Anonymous connections must be clean');
	} else if (connection_message.clientId !== user.client_id && !user.role?.permission?.super_user) {
		throw new Error('Invalid client id, client id from connection must match the client id in the token payload.');
	}
};
