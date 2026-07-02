/**
 * Replicated/forwarded operations (add_ssh_key, add_user, deploy_component) can carry secrets in
 * their request body. The replication send/receive paths log the operation at debug, so those
 * fields must be masked first. redactOperationForLog is that mask; these tests pin its behavior.
 */

import { expect } from 'chai';
import { redactOperationForLog } from '#src/replication/logRedaction';

describe('redactOperationForLog', () => {
	it('masks ssh key contents, passwords, and auth headers', () => {
		const out = redactOperationForLog({
			operation: 'add_ssh_key',
			name: 'deploy',
			key: '-----BEGIN OPENSSH PRIVATE KEY-----',
			password: 'hunter2',
			hdbAuthHeader: 'Basic abc',
		});
		expect(out.key).to.equal('[redacted]');
		expect(out.password).to.equal('[redacted]');
		expect(out.hdbAuthHeader).to.equal('[redacted]');
		expect(out.name).to.equal('deploy');
	});

	it('masks the token in each registryAuth entry while preserving registry/scope', () => {
		const out = redactOperationForLog({
			operation: 'deploy_component',
			project: 'my_app',
			package: 'npm:@myorg/app@1.0.0',
			registryAuth: [
				{ registry: 'https://npm.pkg.github.com', token: 'npm_secret', scope: '@myorg' },
				{ registry: 'registry.example.com', token: 'other_secret' },
			],
		});
		expect(out.registryAuth[0].token).to.equal('[redacted]');
		expect(out.registryAuth[0].registry).to.equal('https://npm.pkg.github.com');
		expect(out.registryAuth[0].scope).to.equal('@myorg');
		expect(out.registryAuth[1].token).to.equal('[redacted]');
		expect(out.registryAuth[1].registry).to.equal('registry.example.com');
		expect(out.project).to.equal('my_app');
		expect(out.package).to.equal('npm:@myorg/app@1.0.0');
	});

	it('returns the same object reference when no sensitive field is present (no allocation)', () => {
		const input = { operation: 'insert', records: [{ id: 1 }] };
		expect(redactOperationForLog(input)).to.equal(input);
	});

	it('does not mutate the original operation', () => {
		const input = {
			operation: 'deploy_component',
			registryAuth: [{ registry: 'https://npm.pkg.github.com', token: 'npm_secret' }],
		};
		redactOperationForLog(input);
		expect(input.registryAuth[0].token).to.equal('npm_secret');
	});

	it('passes through non-object values unchanged', () => {
		expect(redactOperationForLog(undefined)).to.equal(undefined);
		expect(redactOperationForLog(null)).to.equal(null);
		expect(redactOperationForLog('insert')).to.equal('insert');
	});
});
