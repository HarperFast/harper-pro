import Joi from 'joi';
import { validateBySchema } from '../core/validation/validationWrapper.js';
import { ClientError } from '../core/utility/errors/hdbError.js';
import { getPrivateKeys } from '../core/security/keys.js';
import { getJWTRSAKeys } from '../core/security/tokenAuthentication.ts';
import { server } from '../core/server/Server.ts';

type JwtKeyField = 'privateKey' | 'publicKey' | 'passphrase';

const jwtKeyMap: Record<string, JwtKeyField> = {
	'.jwtPrivate': 'privateKey',
	'.jwtPublic': 'publicKey',
	'.jwtPass': 'passphrase',
};

interface KeyResolverRequest {
	bypass_auth?: boolean;
	name: string;
}

interface JWTRSAKeys {
	publicKey: string;
	privateKey: string;
	passphrase: string;
}

/**
 * Resolves a cryptographic key by name for use in replication or resource contexts.
 *
 * Supports JWT RSA keys (`.jwtPrivate`, `.jwtPublic`, `.jwtPass`) and arbitrary
 * private keys managed by the key store.
 *
 * @param req - The request object. Must have `bypass_auth` set to `true` — direct
 *              calls from the operations API are not permitted.
 * @param req.name - The name of the key to retrieve.
 * @returns The resolved key material as a string.
 */
async function keyResolver(req: KeyResolverRequest): Promise<string> {
	const validation = validateBySchema(
		req,
		Joi.object({
			name: Joi.string().required(),
		})
	);
	if (validation) throw new ClientError(validation.message);

	const { name } = req;

	// Handle JWT keys
	const jwtField: JwtKeyField = jwtKeyMap[name];
	if (jwtField) {
		const jwt: JWTRSAKeys = await getJWTRSAKeys();
		return jwt[jwtField];
	}

	// Handle private keys
	const privateKeys = getPrivateKeys();
	const privateKey = privateKeys.get(name);
	if (privateKey) {
		return privateKey;
	}

	throw new ClientError('Key not found');
}

server.registerOperation?.({
	name: 'get_key',
	execute: keyResolver,
	httpMethod: 'GET',
	parametersSchema: [{ name: 'hostname', in: 'path', schema: { type: 'string' } }],
});
