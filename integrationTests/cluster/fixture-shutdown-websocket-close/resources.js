import { writeFileSync } from 'node:fs';

// Commits only after the delay, so a confirmation cannot have arrived before the SIGTERM the test sends once the marker exists.
export class SlowConfirmed extends tables.Confirmed {
	static loadAsInstance = false;
	static async put(target, record, context) {
		writeFileSync(process.env.SHUTDOWN_TEST_ENTERED_FILE, 'entered');
		await new Promise((resolve) => setTimeout(resolve, 1000));
		return super.put(target, record, context);
	}
}
