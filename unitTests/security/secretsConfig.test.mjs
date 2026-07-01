import assert from 'node:assert';
import { describe, it } from 'mocha';
import { parseSecretsConfig } from '#src/security/secretsConfig';

describe('parseSecretsConfig', () => {
	it('returns [] when no secrets are declared', () => {
		assert.deepEqual(parseSecretsConfig(undefined), []);
		assert.deepEqual(parseSecretsConfig(null), []);
		assert.deepEqual(parseSecretsConfig({}), []);
		assert.deepEqual(parseSecretsConfig({ secrets: null }), []);
	});

	it('parses the shorthand list form (all required)', () => {
		assert.deepEqual(parseSecretsConfig({ secrets: ['DATABASE_URL', 'STRIPE_API_KEY'] }), [
			{ name: 'DATABASE_URL', required: true },
			{ name: 'STRIPE_API_KEY', required: true },
		]);
	});

	it('parses the object form with required/description, defaulting required to true', () => {
		const decls = parseSecretsConfig({
			secrets: {
				DATABASE_URL: { required: true, description: 'Postgres DSN' },
				DEBUG_WEBHOOK_URL: { required: false },
				STRIPE_API_KEY: {},
			},
		});
		assert.deepEqual(decls, [
			{ name: 'DATABASE_URL', required: true, description: 'Postgres DSN' },
			{ name: 'DEBUG_WEBHOOK_URL', required: false, description: undefined },
			{ name: 'STRIPE_API_KEY', required: true, description: undefined },
		]);
	});

	it('accepts bare `true` as sugar for { required: true }', () => {
		assert.deepEqual(parseSecretsConfig({ secrets: { API_KEY: true } }), [{ name: 'API_KEY', required: true }]);
	});

	it('dedupes by name (last wins)', () => {
		assert.deepEqual(parseSecretsConfig({ secrets: ['A', 'A'] }), [{ name: 'A', required: true }]);
	});

	it('rejects invalid secret names', () => {
		assert.throws(() => parseSecretsConfig({ secrets: ['has space'] }), /Invalid secret name/);
		assert.throws(() => parseSecretsConfig({ secrets: { '1BAD': true } }), /Invalid secret name/);
	});

	it('rejects malformed shapes', () => {
		assert.throws(() => parseSecretsConfig({ secrets: [123] }), /must be a string/);
		assert.throws(() => parseSecretsConfig({ secrets: { KEY: 'nope' } }), /must map to/);
		assert.throws(() => parseSecretsConfig({ secrets: 'nope' }), /must be a list of names or a map/);
	});
});
