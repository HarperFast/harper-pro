/**
 * Replicated/forwarded operations (add_ssh_key, add_user, deploy_component) can carry secrets in
 * their request body. The replication send/receive paths log the operation at debug, so those
 * fields must be masked first. redactOperationForLog is that mask; these tests pin its behavior.
 */

import { expect } from 'chai';
import { redactOperationForLog } from '#src/replication/logRedaction';
import { UNLOGGABLE_OPERATION_FIELDS } from '#src/core/server/serverHelpers/serverUtilities';

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

	it('masks the token in each credentials entry while preserving registry/scope', () => {
		const out = redactOperationForLog({
			operation: 'deploy_component',
			project: 'my_app',
			package: 'npm:@myorg/app@1.0.0',
			credentials: [
				{ registry: 'https://npm.pkg.github.com', token: 'npm_secret', scope: '@myorg' },
				{ registry: 'registry.example.com', token: 'other_secret' },
			],
		});
		expect(out.credentials[0].token).to.equal('[redacted]');
		expect(out.credentials[0].registry).to.equal('https://npm.pkg.github.com');
		expect(out.credentials[0].scope).to.equal('@myorg');
		expect(out.credentials[1].token).to.equal('[redacted]');
		expect(out.credentials[1].registry).to.equal('registry.example.com');
		expect(out.project).to.equal('my_app');
		expect(out.package).to.equal('npm:@myorg/app@1.0.0');
	});

	it('leaves reference-form credentials un-redacted (a secret name is a pointer, not a credential)', () => {
		// Core's hdb_secret-backed registry auth replicates references, not tokens. A reference has no
		// `token` field, so nothing is masked — and the whole operation returns by identity (no copy).
		const input = {
			operation: 'deploy_component',
			project: 'my_app',
			credentials: [
				{ registry: 'https://npm.pkg.github.com', secret: 'deploy.my_app.npm.pkg.github.com', scope: '@myorg' },
			],
		};
		const out = redactOperationForLog(input);
		expect(out).to.equal(input);
		expect(out.credentials[0].secret).to.equal('deploy.my_app.npm.pkg.github.com');
	});

	it('masks only the token-bearing entries in a mixed reference/token credentials array', () => {
		const out = redactOperationForLog({
			operation: 'deploy_component',
			credentials: [
				{ registry: 'https://npm.pkg.github.com', secret: 'deploy.app.gh', scope: '@myorg' },
				{ registry: 'registry.example.com', token: 'stray_secret' },
			],
		});
		expect(out.credentials[0].secret).to.equal('deploy.app.gh');
		expect(out.credentials[0]).to.not.have.property('token');
		expect(out.credentials[1].token).to.equal('[redacted]');
	});

	it('returns the same object reference when no sensitive field is present (no allocation)', () => {
		const input = { operation: 'insert', records: [{ id: 1 }] };
		expect(redactOperationForLog(input)).to.equal(input);
	});

	it('does not mutate the original operation', () => {
		const input = {
			operation: 'deploy_component',
			credentials: [{ registry: 'https://npm.pkg.github.com', token: 'npm_secret' }],
		};
		redactOperationForLog(input);
		expect(input.credentials[0].token).to.equal('npm_secret');
	});

	it('passes through non-object values unchanged', () => {
		expect(redactOperationForLog(undefined)).to.equal(undefined);
		expect(redactOperationForLog(null)).to.equal(null);
		expect(redactOperationForLog('insert')).to.equal('insert');
	});

	it("masks the requesting user's record, which carries its refresh_token", () => {
		const out = redactOperationForLog({
			operation: 'deploy_component',
			project: 'harper',
			hdb_user: { username: 'admin', refresh_token: 'a-30-day-credential', role: { role: 'super_user' } },
		});
		expect(out.hdb_user).to.equal('[redacted]');
		expect(out.project).to.equal('harper');
		expect(JSON.stringify(out)).to.not.include('a-30-day-credential');
	});

	// The operations log and this one print the same request bodies. `credentials` is the one deliberate
	// difference: references stay visible here, and only a literal token inside an entry is masked.
	it("masks every field core's operation log refuses to print", () => {
		const operation = { operation: 'set_secret' };
		for (const field of UNLOGGABLE_OPERATION_FIELDS) {
			if (field !== 'credentials') operation[field] = `secret-${field}`;
		}
		const out = redactOperationForLog(operation);
		for (const field of UNLOGGABLE_OPERATION_FIELDS) {
			if (field !== 'credentials') expect(out[field], field).to.equal('[redacted]');
		}
	});
});
