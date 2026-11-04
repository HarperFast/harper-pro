import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';

suite('Pro operation input schemas through MCP', (ctx) => {
	let sessionId;
	async function mcp(body, session = sessionId, credentials = ctx.harper.admin) {
		const { username, password } = credentials;
		const response = await fetch(`${ctx.harper.operationsAPIURL}/mcp`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json, text/event-stream',
				'Authorization': `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
				...(session ? { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-06-18' } : {}),
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
		assert.equal(response.status, 200);
		return response;
	}

	before(async () => {
		await startHarper(ctx, {
			config: { waf: { enabled: true }, mcp: { operations: { mountPath: '/mcp' } } },
		});
		const response = await mcp({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'schema-test', version: '0' } },
		});
		sessionId = response.headers.get('mcp-session-id');
		assert.ok(sessionId);
		await response.body?.cancel();
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('default glob matches publish their explicitly registered schemas', async () => {
		const response = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
		const body = await response.json();
		assert.ok(body.result.tools.some((tool) => tool.name === 'describe_all'));
		for (const name of ['list_certificates', 'list_ssh_keys', 'list_waf_rules']) {
			const tool = body.result.tools.find((tool) => tool.name === name);
			assert.ok(tool, `${name} must remain discoverable without a literal allow opt-in`);
			assert.deepEqual(tool.inputSchema, { type: 'object', properties: {} });
		}
	});

	test('all schema-backed pro operations remain callable', async () => {
		for (const [index, name] of ['list_certificates', 'list_ssh_keys', 'list_waf_rules'].entries()) {
			const response = await mcp({
				jsonrpc: '2.0',
				id: 3 + index,
				method: 'tools/call',
				params: { name, arguments: {} },
			});
			const body = await response.json();
			assert.equal(body.result.isError, undefined, name);
			assert.ok(Array.isArray(body.result.structuredContent.results), name);
		}
	});

	test('declared schemas do not expose the tools to a non-super user', async () => {
		const user = { username: 'schema_restricted_user', password: 'Abc1234!' };
		for (const body of [
			{
				operation: 'add_role',
				role: 'schema_restricted_role',
				permission: { super_user: false, operations: ['describe_all'] },
			},
			{ operation: 'add_user', ...user, role: 'schema_restricted_role', active: true },
		]) {
			const { username, password } = ctx.harper.admin;
			const response = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(30_000),
			});
			assert.equal(response.status, 200, await response.text());
		}
		const init = await mcp(
			{
				jsonrpc: '2.0',
				id: 6,
				method: 'initialize',
				params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'restricted', version: '0' } },
			},
			null,
			user
		);
		const restrictedSession = init.headers.get('mcp-session-id');
		assert.ok(restrictedSession);
		await init.body?.cancel();
		const response = await mcp({ jsonrpc: '2.0', id: 7, method: 'tools/list' }, restrictedSession, user);
		const body = await response.json();
		assert.ok(body.result.tools.some((tool) => tool.name === 'describe_all'));
		for (const name of ['list_certificates', 'list_ssh_keys', 'list_waf_rules']) {
			assert.equal(
				body.result.tools.some((tool) => tool.name === name),
				false,
				name
			);
		}
	});
});
