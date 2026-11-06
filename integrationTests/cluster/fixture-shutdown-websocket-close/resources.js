import { existsSync, writeFileSync } from 'node:fs';

// Commits only once the test, having sent SIGTERM, allows it, so no confirmation can arrive before the signal.
export class SlowConfirmed extends tables.Confirmed {
	static loadAsInstance = false;
	static async put(target, record, context) {
		writeFileSync(process.env.SHUTDOWN_TEST_ENTERED_FILE, 'entered');
		const deadline = Date.now() + 20_000;
		while (!existsSync(process.env.SHUTDOWN_TEST_COMMIT_FILE)) {
			if (Date.now() > deadline) throw new Error('The test never allowed the commit');
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		return super.put(target, record, context);
	}
}
