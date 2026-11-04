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
