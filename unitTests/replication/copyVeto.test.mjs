import assert from 'node:assert';
import { clearCopyVeto, cursorEndsCopyVeto } from '#src/replication/replicationConnection';

describe('copy-source vetoes', () => {
	it('clears a veto only while it names the walk the completing write acted for', () => {
		const vetoed = new Map([[4, 200]]);
		// a later walk was vetoed while the older restart write was in flight
		vetoed.set(4, 300);
		clearCopyVeto(vetoed, 4, 200);
		assert.strictEqual(vetoed.get(4), 300);
		clearCopyVeto(vetoed, 4, 300);
		assert.strictEqual(vetoed.has(4), false);
	});

	it('matches a veto recorded without a walk start', () => {
		const vetoed = new Map([[4, undefined]]);
		clearCopyVeto(vetoed, 4, undefined);
		assert.strictEqual(vetoed.has(4), false);
		clearCopyVeto(undefined, 4, undefined);
	});

	it("ends a veto only on a newer pass's cursor", () => {
		assert.strictEqual(cursorEndsCopyVeto(200, 300), true);
		assert.strictEqual(cursorEndsCopyVeto(200, 200), false, "the vetoed walk's own late write");
		assert.strictEqual(cursorEndsCopyVeto(300, 200), false, "an older pass's late write");
		assert.strictEqual(cursorEndsCopyVeto(undefined, 300), false, 'no veto when the write was issued');
	});
});
