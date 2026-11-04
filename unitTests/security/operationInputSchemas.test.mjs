import assert from 'node:assert';
import { normalizeOperationInputSchema } from '#src/core/server/serverHelpers/validateOperationInputSchema';

describe('Pro operation schema dialect dependencies', () => {
	for (const $schema of [
		'http://json-schema.org/draft-06/schema#',
		'http://json-schema.org/draft-07/schema#',
		'https://json-schema.org/draft/2019-09/schema',
		'https://json-schema.org/draft/2020-12/schema',
	]) {
		it(`validates ${$schema} through the installed Pro runtime graph`, () => {
			const result = normalizeOperationInputSchema({
				$schema,
				type: 'object',
				definitions: { Value: { type: 'string' } },
				properties: { value: { $ref: '#/definitions/Value' } },
			});
			assert.equal(result.error, undefined, result.error);
			assert.ok(result.schema);
		});
	}
});

describe('Pro shared Ajv HTTP validation', () => {
	it('accepts valid bodies and rejects missing or invalid values through Fastify', async () => {
		const { default: Fastify } = await import('fastify');
		const app = Fastify();
		try {
			app.post(
				'/schema-smoke',
				{
					schema: {
						body: {
							type: 'object',
							required: ['value'],
							properties: { value: { type: 'string', minLength: 2 } },
						},
					},
				},
				async (request) => request.body
			);
			for (const [payload, status] of [
				[{ value: 'ok' }, 200],
				[{}, 400],
				[{ value: 'x' }, 400],
			]) {
				const response = await app.inject({ method: 'POST', url: '/schema-smoke', payload });
				assert.equal(response.statusCode, status, response.body);
			}
		} finally {
			await app.close();
		}
	});
});
