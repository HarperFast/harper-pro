/**
 * Coverage for the JWT key-clone helpers (harper-pro). These guard the clone path that copies the
 * leader's JWT signing keys onto a new node: a transient `get_key` failure or an empty response used
 * to be swallowed, leaving the node with a missing/partial key set that surfaced downstream as
 * "unable to generate JWT as there are no encryption keys". The helpers retry transient failures,
 * accept both response shapes the operations layer can produce, and fail loudly when a key can't be
 * obtained.
 */
import { expect } from 'chai';
import { extractKeyMaterial, fetchJWTKeyWithRetry } from '#src/cloneNode/jwtKeyClone';

describe('extractKeyMaterial', () => {
	it('reads the wrapped { message } shape (HTTP operations response)', () => {
		expect(extractKeyMaterial({ message: 'key-material' })).to.equal('key-material');
	});

	it('reads a bare string shape (cert-auth replication response)', () => {
		expect(extractKeyMaterial('key-material')).to.equal('key-material');
	});

	it('returns undefined for empty or missing content', () => {
		expect(extractKeyMaterial({ message: '' })).to.equal(undefined);
		expect(extractKeyMaterial('')).to.equal(undefined);
		expect(extractKeyMaterial({})).to.equal(undefined);
		expect(extractKeyMaterial(null)).to.equal(undefined);
		expect(extractKeyMaterial(undefined)).to.equal(undefined);
	});

	it('returns undefined for non-string message content', () => {
		expect(extractKeyMaterial({ message: 123 })).to.equal(undefined);
		expect(extractKeyMaterial({ message: { nested: true } })).to.equal(undefined);
	});
});

describe('fetchJWTKeyWithRetry', () => {
	it('returns the key on first success without retrying', async () => {
		let calls = 0;
		const result = await fetchJWTKeyWithRetry(
			async () => {
				calls++;
				return { message: 'the-key' };
			},
			'.jwtPass',
			3,
			1
		);
		expect(result).to.equal('the-key');
		expect(calls).to.equal(1);
	});

	it('retries transient rejections and then succeeds', async () => {
		let calls = 0;
		const result = await fetchJWTKeyWithRetry(
			async () => {
				calls++;
				if (calls < 3) throw new Error('connection reset');
				return 'the-key';
			},
			'.jwtPrivate',
			3,
			1
		);
		expect(result).to.equal('the-key');
		expect(calls).to.equal(3);
	});

	it('retries empty responses and then succeeds', async () => {
		let calls = 0;
		const result = await fetchJWTKeyWithRetry(
			async () => {
				calls++;
				return calls < 2 ? { message: '' } : { message: 'the-key' };
			},
			'.jwtPublic',
			3,
			1
		);
		expect(result).to.equal('the-key');
		expect(calls).to.equal(2);
	});

	it('throws after exhausting retries on persistent rejection, preserving the cause', async () => {
		let calls = 0;
		const cause = new Error('connection refused');
		let thrown;
		try {
			await fetchJWTKeyWithRetry(
				async () => {
					calls++;
					throw cause;
				},
				'.jwtPass',
				3,
				1
			);
		} catch (err) {
			thrown = err;
		}
		expect(calls).to.equal(3);
		expect(thrown).to.be.an('error');
		expect(thrown.message).to.contain('.jwtPass');
		expect(thrown.message).to.contain('3 attempts');
		expect(thrown.cause).to.equal(cause);
	});

	it('throws after exhausting retries on persistent empty responses', async () => {
		let calls = 0;
		let thrown;
		try {
			await fetchJWTKeyWithRetry(async () => ({ message: '' }), '.jwtPublic', 2, 1);
		} catch (err) {
			thrown = err;
			calls = 1;
		}
		expect(calls).to.equal(1);
		expect(thrown).to.be.an('error');
		expect(thrown.message).to.contain('.jwtPublic');
		expect(thrown.cause).to.be.an('error');
		expect(thrown.cause.message).to.contain('empty response');
	});
});
