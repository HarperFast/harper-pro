import assert from 'node:assert';
import { clearCopyVeto, cursorEndsCopyVeto } from '#src/replication/replicationConnection';

describe('copy-source vetoes', () => {
	it('clears a veto only while it is the one the completing write captured', () => {
		const older = { walkStart: 200 };
		const vetoed = new Map([[4, older]]);
		// a later walk was vetoed while the older restart write was in flight, from the same copy start
		const newer = { walkStart: 200 };
		vetoed.set(4, newer);
		clearCopyVeto(vetoed, 4, older);
		assert.strictEqual(vetoed.get(4), newer);
		clearCopyVeto(vetoed, 4, newer);
		assert.strictEqual(vetoed.has(4), false);
	});

	it('clears nothing for a write issued with no veto in place', () => {
		const vetoed = new Map([[4, { walkStart: 300 }]]);
		clearCopyVeto(vetoed, 4, undefined);
		assert.strictEqual(vetoed.has(4), true);
		clearCopyVeto(undefined, 4, undefined);
	});

	it("ends a veto only on a newer pass's cursor", () => {
		assert.strictEqual(cursorEndsCopyVeto(200, 300), true);
		assert.strictEqual(
			cursorEndsCopyVeto(200, 200),
			false,
			"the vetoed walk's own late write, or one from its copy start"
		);
		assert.strictEqual(cursorEndsCopyVeto(300, 200), false, "an older pass's late write");
		assert.strictEqual(cursorEndsCopyVeto(undefined, 300), false, 'a veto with no walk start');
	});
});
