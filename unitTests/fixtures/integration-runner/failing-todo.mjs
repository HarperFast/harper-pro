import { test } from 'node:test';
import assert from 'node:assert';

test('failing todo with a reason', { todo: 'known bug' }, () => {
	throw new Error('expected failure');
});
test('failing todo with an empty reason', { todo: '' }, () => {
	throw new Error('expected failure');
});
if (process.env.FAIL_FOR_REAL) test('a real failure', () => assert.fail('real failure'));
