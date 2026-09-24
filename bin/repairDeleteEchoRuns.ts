import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
	repairHarperRoot,
	restoreRepair,
	RepairRefusedError,
	type DatabaseReport,
} from '../replication/repairDeleteEchoRuns.ts';

const USAGE = `Compacts echoed replicated-delete runs (harper-pro#826) out of a stopped Harper node's RocksDB transaction logs.

  node dist/bin/repairDeleteEchoRuns.js <harper-root>            report what a repair would drop
  node dist/bin/repairDeleteEchoRuns.js <harper-root> --apply    repair (Harper and its supervisor stopped)
  node dist/bin/repairDeleteEchoRuns.js --restore <backup-dir>   put back the originals a repair replaced

--apply and --restore hold the database open for their whole run, so they refuse while Harper has it open and
Harper cannot start until they finish. A report taken while Harper runs is advisory. Run it only after every
node in the cluster has the fix that stops new runs.`;

function formatBytes(bytes: number): string {
	return bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MiB` : `${bytes} B`;
}

function printReport(report: DatabaseReport, apply: boolean): void {
	console.log(`${report.path}`);
	for (const backupDir of report.removedBackups)
		console.log(`  removed ${backupDir}: a repair stopped before touching the database left it behind`);
	if (report.refused) {
		console.log(`  refused: ${report.refused}`);
		return;
	}
	for (const log of report.logs) {
		const action = apply && report.applied ? 'dropped' : 'would drop';
		console.log(
			`  log ${log.name}: ${log.files} files, ${log.entries} entries; ${action} ${log.dropped} echoed deletes ` +
				`(${formatBytes(log.bytesReclaimed)}) from ${log.rewritten.length} files; largest single-timestamp run ` +
				`${formatBytes(log.largestSpanBefore)} -> ${formatBytes(log.largestSpanAfter)}`
		);
		if (log.createdTailFile)
			console.log(`    started ${log.createdTailFile} so no stale derived-index coverage matches`);
		for (const { file, reason } of log.refused) console.log(`    not repaired ${file}: ${reason}`);
	}
	if (report.backupDir)
		console.log(
			`  originals kept in ${report.backupDir}; delete it once replication has converged, or undo with --restore`
		);
}

/**
 * Started as root, become the owner of the files before touching them: every file a repair writes, RocksDB's
 * own included, then belongs to that user, and no path-based chown can be redirected through a link.
 */
function runAsOwnerOf(path: string): void {
	if (process.getuid?.() !== 0) return;
	const { uid, gid } = statSync(path);
	if (uid === 0) return;
	process.setgroups([gid]);
	process.setgid(gid);
	process.setuid(uid);
}

async function main(): Promise<number> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			apply: { type: 'boolean' },
			restore: { type: 'string' },
			help: { type: 'boolean' },
		},
	});
	if (values.help || (values.restore === undefined) === (positionals.length !== 1)) {
		console.log(USAGE);
		return values.help ? 0 : 2;
	}
	if (values.restore !== undefined) {
		runAsOwnerOf(dirname(values.restore));
		await restoreRepair(values.restore);
		console.log(`restored the originals recorded in ${values.restore}`);
		return 0;
	}
	const root = positionals[0];
	if (values.apply) runAsOwnerOf(join(root, 'database'));
	const reports = await repairHarperRoot(root, { apply: values.apply });
	for (const report of reports) printReport(report, values.apply);
	if (reports.length === 0) console.log(`no RocksDB databases with transaction logs under ${root}/database`);
	// a refused file may still hold the run that wedges replication
	return reports.some((report) => report.refused || report.logs.some((log) => log.refused.length > 0)) ? 1 : 0;
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(error) => {
		console.error(error instanceof RepairRefusedError ? `refused: ${error.message}` : error);
		process.exitCode = 1;
	}
);
