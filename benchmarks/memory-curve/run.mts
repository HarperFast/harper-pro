/**
 * One-command driver for the memory-curve benchmark on throwaway GCP VMs.
 *
 *   node benchmarks/memory-curve/run.mts --project <id> [--profile full|smoke] [--pairs a,b]
 *   node benchmarks/memory-curve/run.mts resume  --run-id <id> --project <id>
 *   node benchmarks/memory-curve/run.mts status  --run-id <id> --project <id>
 *   node benchmarks/memory-curve/run.mts cleanup --run-id <id> --project <id>
 *   node benchmarks/memory-curve/run.mts report  --run-id <id>
 *
 * `run` creates one server VM (the production host shape) and one client VM per pair, plus two
 * firewall rules scoped to this run's network tags; provisions them; starts the orchestrator on each
 * client; polls until every pair is done; fetches and checksums the results; deletes every resource;
 * and writes the report. Resource names are recorded in runs/<run-id>/manifest.json before they are
 * created, so `cleanup` can always find them, and each VM also deletes itself at --max-run-hours.
 * See README.md for every option.
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { estimatedHours, planProfile, type PairPlan } from './matrix.mts';
import { writeJSON, type OrchestratorPlan } from './orchestrate.mts';
import { writeReport } from './report.mts';

const HERE = import.meta.dirname;
const REPO_ROOT = join(HERE, '..', '..');
const REMOTE = '/opt/memory-curve';
const USER = 'bench';
const RUN_ID_PATTERN = /^[a-z][a-z0-9]{2,19}$/;
const LOST_AFTER_FAILED_POLLS = 6;
const FETCH_ATTEMPTS = 3;

interface Options {
	command: string;
	project: string;
	zone: string;
	profile: string;
	pairs?: string[];
	runId: string;
	keep: boolean;
	adc: boolean;
	gcloud: string;
	maxRunHours: number;
	sshSource?: string;
	allowDirty: boolean;
	pollMinutes: number;
	serverMachine: string;
	clientMachine: string;
	bootDiskType: string;
	bootDiskGb: number;
	dataDiskType: string;
	dataDiskGb: number;
	dryRun: boolean;
}

interface VmRecord {
	name: string;
	internalIp?: string;
	externalIp?: string;
}

interface Manifest {
	runId: string;
	project: string;
	zone: string;
	profile: string;
	createdAt: string;
	harperCommit: string;
	maxRunHours: number;
	sshSource: string;
	firewallRules: string[];
	pairs: PairRecord[];
	state: 'creating' | 'running' | 'fetched' | 'cleaned';
}

interface PairRecord {
	name: string;
	server: VmRecord;
	client: VmRecord;
	/** How the pair's orchestrator ended; `lost` when its client stopped answering, `crashed` when it kept dying. */
	outcome?: 'DONE' | 'FAILED' | 'lost' | 'crashed';
	/** Where its results are now: verified copy, or best-effort copy of an unfinished pair. */
	saved?: 'fetched' | 'partial';
	/** Its orchestrator was started, so its VMs may hold measurements. */
	started?: boolean;
}

/** Awaits every operation, so nothing is still creating resources when the first failure propagates. */
async function settleAll(operations: Array<Promise<unknown>>): Promise<void> {
	const results = await Promise.allSettled(operations);
	const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
	if (failures.length > 0) throw new Error(failures.map((failure) => (failure.reason as Error).message).join('\n'));
}

function parseOptions(argv: string[]): Options {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			'project': { type: 'string', default: process.env.MEMORY_CURVE_PROJECT },
			'zone': { type: 'string', default: 'us-central1-a' },
			'profile': { type: 'string', default: 'full' },
			'pairs': { type: 'string' },
			'run-id': { type: 'string' },
			'keep': { type: 'boolean', default: false },
			'adc': { type: 'boolean', default: false },
			'gcloud': { type: 'string', default: 'gcloud' },
			'max-run-hours': { type: 'string', default: '46' },
			'ssh-source': { type: 'string' },
			'allow-dirty': { type: 'boolean', default: false },
			'poll-minutes': { type: 'string', default: '10' },
			'server-machine': { type: 'string', default: 'n2d-highmem-4' },
			'client-machine': { type: 'string', default: 'n2d-standard-8' },
			'boot-disk-type': { type: 'string', default: 'pd-ssd' },
			'boot-disk-gb': { type: 'string', default: '64' },
			'data-disk-type': { type: 'string', default: 'pd-balanced' },
			'data-disk-gb': { type: 'string', default: '400' },
			'dry-run': { type: 'boolean', default: false },
		},
	});
	const command = positionals[0] ?? 'run';
	if (!['run', 'resume', 'status', 'cleanup', 'report'].includes(command))
		throw new Error(`unknown command ${command}`);
	const runId =
		values['run-id'] ??
		(command === 'run'
			? `mc${new Date().toISOString().slice(2, 19).replace(/\D/g, '')}${randomBytes(2).toString('hex').slice(0, 2)}`
			: '');
	if (!RUN_ID_PATTERN.test(runId)) throw new Error(`--run-id must match ${RUN_ID_PATTERN} (got "${runId}")`);
	if (command !== 'report' && !values.project) throw new Error('--project (or MEMORY_CURVE_PROJECT) is required');
	const positive = (name: string, text: string): number => {
		const value = Number(text);
		if (!(value > 0)) throw new Error(`--${name} must be a positive number, got ${text}`);
		return value;
	};
	return {
		command,
		project: values.project ?? '',
		zone: values.zone!,
		profile: values.profile!,
		pairs: values.pairs?.split(',').filter(Boolean),
		runId,
		keep: values.keep!,
		adc: values.adc!,
		gcloud: values.gcloud!,
		maxRunHours: positive('max-run-hours', values['max-run-hours']!),
		sshSource: values['ssh-source'],
		allowDirty: values['allow-dirty']!,
		pollMinutes: positive('poll-minutes', values['poll-minutes']!),
		serverMachine: values['server-machine']!,
		clientMachine: values['client-machine']!,
		bootDiskType: values['boot-disk-type']!,
		bootDiskGb: positive('boot-disk-gb', values['boot-disk-gb']!),
		dataDiskType: values['data-disk-type']!,
		dataDiskGb: positive('data-disk-gb', values['data-disk-gb']!),
		dryRun: values['dry-run']!,
	};
}

/** Retries an ssh/scp call that failed before reaching the host, when the remote command never ran. */
async function retryConnect<T>(operation: () => Promise<T>, attempts = 4): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await operation();
		} catch (error) {
			const stderr = String((error as { stderr?: string }).stderr ?? '');
			const connectFailure =
				/connect to host .* port \d+: |kex_exchange_identification|Connection closed by .* port \d+$/m.test(stderr);
			if (!connectFailure || attempt >= attempts) throw error;
			await delay(15_000 * attempt);
		}
	}
}

function exec(file: string, args: string[], timeoutMs = 10 * 60_000): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error)
				reject(
					Object.assign(new Error(`${file} ${args.slice(0, 4).join(' ')} failed: ${stderr.trim() || error.message}`), {
						stderr,
					})
				);
			else resolve(stdout);
		});
	});
}

function log(message: string): void {
	console.log(`${new Date().toISOString()} ${message}`);
}

class Launcher {
	readonly options: Options;
	readonly runDir: string;
	readonly key: string;
	manifest!: Manifest;

	constructor(options: Options) {
		this.options = options;
		this.runDir = join(HERE, 'runs', options.runId);
		this.key = join(this.runDir, 'launcher_key');
	}

	async gcloud(args: string[], timeoutMs?: number): Promise<string> {
		const extra = [`--project=${this.options.project}`, '--quiet'];
		if (this.options.adc) {
			const tokenFile = join(this.runDir, '.access-token');
			const token = await exec(this.options.gcloud, ['auth', 'application-default', 'print-access-token']);
			await writeFile(tokenFile, token.trim(), { mode: 0o600 });
			extra.push(`--access-token-file=${tokenFile}`);
		}
		return exec(this.options.gcloud, [...args, ...extra], timeoutMs);
	}

	sshArgs(host: string): string[] {
		return [
			'-i',
			this.key,
			'-o',
			'IdentitiesOnly=yes',
			'-o',
			'BatchMode=yes',
			'-o',
			'StrictHostKeyChecking=accept-new',
			'-o',
			`UserKnownHostsFile=${join(this.runDir, 'known_hosts')}`,
			'-o',
			'ConnectTimeout=20',
			'-o',
			'ServerAliveInterval=30',
			`${USER}@${host}`,
		];
	}

	ssh(host: string, command: string, timeoutMs = 10 * 60_000): Promise<string> {
		return retryConnect(() => exec('ssh', [...this.sshArgs(host), command], timeoutMs));
	}

	scp(sources: string[], destination: string, timeoutMs = 30 * 60_000): Promise<string> {
		return retryConnect(() =>
			exec(
				'scp',
				[
					'-i',
					this.key,
					'-o',
					'IdentitiesOnly=yes',
					'-o',
					'BatchMode=yes',
					'-o',
					'StrictHostKeyChecking=accept-new',
					'-o',
					`UserKnownHostsFile=${join(this.runDir, 'known_hosts')}`,
					'-r',
					...sources,
					destination,
				],
				timeoutMs
			)
		);
	}

	async saveManifest(): Promise<void> {
		await writeJSON(join(this.runDir, 'manifest.json'), this.manifest);
	}

	async loadManifest(): Promise<void> {
		const file = join(this.runDir, 'manifest.json');
		if (!existsSync(file)) throw new Error(`no manifest at ${file}`);
		this.manifest = JSON.parse(await readFile(file, 'utf8'));
		if (this.manifest.project !== this.options.project) {
			throw new Error(
				`run ${this.options.runId} belongs to project ${this.manifest.project}, not ${this.options.project}`
			);
		}
	}

	names(pair: string): { server: string; client: string } {
		return { server: `mc-${this.options.runId}-${pair}-s`, client: `mc-${this.options.runId}-${pair}-c` };
	}

	async sourceTarball(): Promise<string> {
		const status = await exec('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--ignore-submodules=none']);
		if (status.trim() && !this.options.allowDirty) {
			throw new Error(
				`uncommitted changes would not reach the VMs (they run HEAD); commit them or pass --allow-dirty:\n${status}`
			);
		}
		const tarball = join(this.runDir, 'source.tar');
		await exec('git', ['-C', REPO_ROOT, 'archive', '--format=tar', '-o', tarball, 'HEAD']);
		const coreTar = join(this.runDir, 'core.tar');
		await exec('git', [
			'-C',
			join(REPO_ROOT, 'core'),
			'archive',
			'--format=tar',
			'--prefix=core/',
			'-o',
			coreTar,
			'HEAD',
		]);
		await exec('tar', ['--concatenate', '-f', tarball, coreTar]);
		await rm(coreTar);
		await exec('gzip', ['-f', tarball]);
		return `${tarball}.gz`;
	}

	async detectSshSource(): Promise<string> {
		if (this.options.sshSource) return this.options.sshSource;
		const response = await fetch('https://checkip.amazonaws.com/', { signal: AbortSignal.timeout(10_000) });
		const ip = (await response.text()).trim();
		if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip))
			throw new Error(`could not detect this machine's public IP (got "${ip}"); pass --ssh-source`);
		return `${ip}/32`;
	}

	async create(plans: PairPlan[]): Promise<void> {
		const { options } = this;
		await mkdir(this.runDir, { recursive: true });
		if (!existsSync(this.key))
			await exec('ssh-keygen', [
				'-q',
				'-t',
				'ed25519',
				'-N',
				'',
				'-C',
				`memory-curve-${options.runId}`,
				'-f',
				this.key,
			]);
		const runKey = join(this.runDir, 'run_key');
		if (!existsSync(runKey))
			await exec('ssh-keygen', [
				'-q',
				'-t',
				'ed25519',
				'-N',
				'',
				'-C',
				`memory-curve-${options.runId}-client`,
				'-f',
				runKey,
			]);
		const sshSource = await this.detectSshSource();
		this.manifest = {
			runId: options.runId,
			project: options.project,
			zone: options.zone,
			profile: options.profile,
			createdAt: new Date().toISOString(),
			maxRunHours: options.maxRunHours,
			harperCommit: (await exec('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'])).trim(),
			sshSource,
			firewallRules: [`mc-${options.runId}-harper`, `mc-${options.runId}-ssh`],
			pairs: plans.map((plan) => {
				const names = this.names(plan.name);
				return { name: plan.name, server: { name: names.server }, client: { name: names.client } };
			}),
			state: 'creating',
		};
		await this.saveManifest();
		const tag = `mc-${options.runId}`;
		log(`firewall: Harper ports client -> server, SSH from ${sshSource}`);
		await this.gcloud([
			'compute',
			'firewall-rules',
			'create',
			`${tag}-harper`,
			'--network=default',
			'--direction=INGRESS',
			'--action=ALLOW',
			'--rules=tcp:22,tcp:9925,tcp:9926',
			`--source-tags=${tag}-client`,
			`--target-tags=${tag}-server`,
			`--description=memory-curve benchmark run ${options.runId}; delete after the run`,
		]);
		await this.gcloud([
			'compute',
			'firewall-rules',
			'create',
			`${tag}-ssh`,
			'--network=default',
			'--direction=INGRESS',
			'--action=ALLOW',
			'--rules=tcp:22',
			`--source-ranges=${sshSource}`,
			`--target-tags=${tag}`,
			`--description=memory-curve benchmark run ${options.runId}; delete after the run`,
		]);
		const launcherKey = (await readFile(`${this.key}.pub`, 'utf8')).trim();
		const clientKey = (await readFile(`${runKey}.pub`, 'utf8')).trim();
		await writeFile(join(this.runDir, 'ssh-keys-server'), `${USER}:${launcherKey}\n${USER}:${clientKey}\n`);
		await writeFile(join(this.runDir, 'ssh-keys-client'), `${USER}:${launcherKey}\n`);
		const common = [
			`--zone=${options.zone}`,
			'--image-family=ubuntu-2204-lts',
			'--image-project=ubuntu-os-cloud',
			`--max-run-duration=${Math.floor(options.maxRunHours)}h`,
			'--instance-termination-action=DELETE',
		];
		await settleAll(
			plans.map(async (plan) => {
				const { server, client } = this.names(plan.name);
				const labels = (role: string) =>
					`--labels=purpose=memory-curve-bench,run=${options.runId},pair=${plan.name},role=${role}`;
				log(`create: ${server} (${options.serverMachine}) and ${client} (${options.clientMachine})`);
				await this.gcloud([
					'compute',
					'instances',
					'create',
					server,
					...common,
					`--machine-type=${options.serverMachine}`,
					`--boot-disk-size=${options.bootDiskGb}GB`,
					`--boot-disk-type=${options.bootDiskType}`,
					`--create-disk=name=${server}-data,size=${options.dataDiskGb}GB,type=${options.dataDiskType},device-name=data,auto-delete=yes`,
					labels('server'),
					`--tags=${tag},${tag}-server`,
					`--metadata-from-file=ssh-keys=${join(this.runDir, 'ssh-keys-server')}`,
				]);
				await this.gcloud([
					'compute',
					'instances',
					'create',
					client,
					...common,
					`--machine-type=${options.clientMachine}`,
					'--boot-disk-size=50GB',
					'--boot-disk-type=pd-balanced',
					labels('client'),
					`--tags=${tag},${tag}-client`,
					`--metadata-from-file=ssh-keys=${join(this.runDir, 'ssh-keys-client')}`,
				]);
			})
		);
		await this.refreshAddresses();
	}

	async refreshAddresses(): Promise<void> {
		const listing = JSON.parse(
			await this.gcloud(['compute', 'instances', 'list', `--filter=labels.run=${this.options.runId}`, '--format=json'])
		) as any[];
		const byName = new Map(listing.map((instance) => [instance.name, instance]));
		for (const pair of this.manifest.pairs) {
			for (const vm of [pair.server, pair.client]) {
				const instance = byName.get(vm.name);
				if (!instance) throw new Error(`instance ${vm.name} not found`);
				vm.internalIp = instance.networkInterfaces[0].networkIP;
				vm.externalIp = instance.networkInterfaces[0].accessConfigs?.[0]?.natIP;
			}
		}
		await this.saveManifest();
	}

	async waitForSsh(host: string): Promise<void> {
		const deadline = Date.now() + 10 * 60_000;
		for (;;) {
			try {
				await this.ssh(host, 'true', 30_000);
				return;
			} catch (error) {
				if (Date.now() > deadline) throw error;
				await delay(10_000);
			}
		}
	}

	async provision(plans: PairPlan[], tarball: string): Promise<void> {
		const runKey = join(this.runDir, 'run_key');
		await settleAll(
			this.manifest.pairs.map(async (pair) => {
				const plan = plans.find((candidate) => candidate.name === pair.name)!;
				const server = pair.server.externalIp!;
				const client = pair.client.externalIp!;
				await Promise.all([this.waitForSsh(server), this.waitForSsh(client)]);
				const password = randomBytes(18).toString('base64url');
				const passwordFile = join(this.runDir, `${pair.name}.password`);
				await writeFile(passwordFile, password, { mode: 0o600 });
				const orchestratorPlan: OrchestratorPlan = {
					runId: this.options.runId,
					harperCommit: this.manifest.harperCommit,
					pair: plan,
					server: { host: pair.server.internalIp!, user: USER, sshKey: `${REMOTE}/run_key` },
					adminPassword: password,
					client: {
						workers: 0,
						inFlightCapPerWorker: 256,
						requestTimeoutMs: 10_000,
						calibrationConcurrency: 256,
						loadConcurrency: 32,
					},
				};
				const planFile = join(this.runDir, `${pair.name}.plan.json`);
				await writeFile(planFile, JSON.stringify(orchestratorPlan, null, '\t'), { mode: 0o600 });
				log(`provision ${pair.name}: server (image build takes ~15 min) and client`);
				await settleAll([
					(async () => {
						await this.scp([tarball, join(HERE, 'server-setup.sh'), passwordFile], `${USER}@${server}:/tmp/`);
						await this.ssh(
							server,
							`sudo bash /tmp/server-setup.sh /tmp/source.tar.gz /tmp/${pair.name}.password > /tmp/server-setup.log 2>&1 || { tail -50 /tmp/server-setup.log; exit 1; }`,
							60 * 60_000
						);
					})(),
					(async () => {
						await this.scp([tarball, join(HERE, 'client-setup.sh'), runKey, planFile], `${USER}@${client}:/tmp/`);
						await this.ssh(
							client,
							`sudo bash /tmp/client-setup.sh /tmp/source.tar.gz ${process.version} ${USER} && ` +
								`install -m 0600 /tmp/run_key ${REMOTE}/run_key && install -m 0600 /tmp/${pair.name}.plan.json ${REMOTE}/plan.json && rm -f /tmp/run_key /tmp/${pair.name}.plan.json`,
							30 * 60_000
						);
					})(),
				]);
				await rm(passwordFile);
			})
		);
	}

	async startOrchestrator(pair: PairRecord): Promise<void> {
		await this.ssh(pair.client.externalIp!, `bash ${REMOTE}/client-ctl.sh start`);
		pair.started = true;
		await this.saveManifest();
	}

	async pairState(client: string): Promise<{ marker: 'DONE' | 'FAILED' | null; alive: boolean; status: any }> {
		const output = await this.ssh(client, `bash ${REMOTE}/client-ctl.sh status`, 60_000);
		const marker = /marker=(DONE|FAILED)/.exec(output)?.[1] as 'DONE' | 'FAILED' | undefined;
		const json = output.slice(output.indexOf('{'));
		let status: any = {};
		try {
			status = JSON.parse(json);
		} catch {
			// status.json is replaced atomically; a parse failure means it was absent
		}
		return { marker: marker ?? null, alive: output.includes('alive=yes'), status };
	}

	/** Polls until every pair has ended and been fetched, been lost, or the run's VM lifetime has passed. */
	async waitForPairs(): Promise<void> {
		const restarts = new Map<string, number>();
		const failedPolls = new Map<string, number>();
		const fetchFailures = new Map<string, number>();
		const deadline = Date.parse(this.manifest.createdAt) + this.manifest.maxRunHours * 3600_000;
		for (;;) {
			let pending = 0;
			for (const pair of this.manifest.pairs) {
				if (pair.saved === 'fetched' || pair.outcome === 'lost' || pair.outcome === 'crashed') continue;
				let state;
				try {
					state = await this.pairState(pair.client.externalIp!);
					failedPolls.set(pair.name, 0);
				} catch (error) {
					const count = (failedPolls.get(pair.name) ?? 0) + 1;
					failedPolls.set(pair.name, count);
					log(`${pair.name}: status unavailable ${count}x (${(error as Error).message.split('\n')[0]})`);
					if (count >= LOST_AFTER_FAILED_POLLS) {
						pair.outcome = 'lost';
						await this.saveManifest();
						log(`${pair.name}: client unreachable for ${count} polls; giving up on it`);
					} else {
						pending++;
					}
					continue;
				}
				const { marker, alive, status } = state;
				if (!marker && alive) pending++;
				log(
					`${pair.name}: ${marker ?? status.phase ?? 'starting'} ${status.done ?? 0}/${status.total ?? '?'} ${status.current ?? ''}`
				);
				if (marker) {
					pair.outcome = marker;
					try {
						await this.fetch(pair);
					} catch (error) {
						const count = (fetchFailures.get(pair.name) ?? 0) + 1;
						fetchFailures.set(pair.name, count);
						log(`${pair.name}: fetch attempt ${count} failed: ${(error as Error).message.split('\n')[0]}`);
						if (count < FETCH_ATTEMPTS) pending++;
					}
					continue;
				}
				if (!alive) {
					const count = (restarts.get(pair.name) ?? 0) + 1;
					if (count > 3) {
						pair.outcome = 'crashed';
						await this.saveManifest();
						log(
							`${pair.name}: orchestrator died ${count - 1} times; see ${REMOTE}/orchestrate.out on ${pair.client.name}`
						);
						continue;
					}
					restarts.set(pair.name, count);
					pending++;
					log(`${pair.name}: orchestrator not running and no result marker; restarting it (it resumes)`);
					await this.startOrchestrator(pair);
				}
			}
			if (pending === 0) break;
			if (Date.now() > deadline) throw new Error(`run passed its ${this.manifest.maxRunHours} h VM lifetime`);
			await delay(this.options.pollMinutes * 60_000);
		}
		const unfetched = this.manifest.pairs.filter((pair) => pair.saved !== 'fetched').map((pair) => pair.name);
		if (unfetched.length > 0) throw new Error(`results not fetched for ${unfetched.join(', ')}`);
	}

	async fetch(pair: PairRecord): Promise<void> {
		const destination = join(this.runDir, pair.name);
		await rm(destination, { recursive: true, force: true });
		await this.scp([`${USER}@${pair.client.externalIp}:${REMOTE}/results`], destination);
		await verifyChecksums(destination);
		pair.saved = 'fetched';
		await this.saveManifest();
		log(`${pair.name}: results fetched to ${destination} and checksums verified`);
	}

	/** Best-effort copy of whatever an unfinished pair produced, kept beside the run. */
	async fetchPartial(): Promise<void> {
		for (const pair of this.manifest.pairs) {
			if (pair.saved || !pair.client.externalIp) continue;
			const destination = join(this.runDir, `${pair.name}-partial`);
			try {
				await this.ssh(pair.client.externalIp, `bash ${REMOTE}/client-ctl.sh stop`, 60_000);
				await rm(destination, { recursive: true, force: true });
				await this.scp([`${USER}@${pair.client.externalIp}:${REMOTE}/results`], destination);
				await this.scp([`${USER}@${pair.client.externalIp}:${REMOTE}/orchestrate.out`], destination).catch(() => '');
				pair.saved = 'partial';
				await this.saveManifest();
				log(`${pair.name}: partial results saved to ${destination}`);
			} catch (error) {
				log(`${pair.name}: could not fetch partial results: ${(error as Error).message.split('\n')[0]}`);
			}
		}
	}

	/** Pairs whose VMs may hold results not copied here; a partial copy is taken only after the pair stopped. */
	unsavedPairs(): string[] {
		return this.manifest.pairs.filter((pair) => !pair.saved && pair.client.externalIp).map((pair) => pair.name);
	}

	/** A resumed run may come from another address than the one its SSH rule admits. */
	async refreshSshSource(): Promise<void> {
		const sshSource = await this.detectSshSource();
		if (sshSource === this.manifest.sshSource) return;
		log(`firewall: SSH source ${this.manifest.sshSource} -> ${sshSource}`);
		await this.gcloud([
			'compute',
			'firewall-rules',
			'update',
			`mc-${this.options.runId}-ssh`,
			`--source-ranges=${sshSource}`,
		]);
		this.manifest.sshSource = sshSource;
		await this.saveManifest();
	}

	async cleanup(): Promise<void> {
		const { runId } = this.options;
		const { zone } = this.manifest;
		const instanceNames = this.manifest.pairs.flatMap((pair) => [pair.server.name, pair.client.name]);
		const listed = (
			await this.gcloud(['compute', 'instances', 'list', `--filter=labels.run=${runId}`, '--format=value(name)'])
		)
			.split('\n')
			.filter(Boolean);
		const toDelete = [...new Set([...instanceNames, ...listed])].filter((name) => name.startsWith(`mc-${runId}-`));
		const existing = new Set(listed);
		const present = toDelete.filter((name) => existing.has(name));
		if (present.length > 0) {
			log(`cleanup: deleting instances ${present.join(', ')}`);
			await this.gcloud(
				['compute', 'instances', 'delete', ...present, `--zone=${zone}`, '--delete-disks=all'],
				30 * 60_000
			);
		}
		const rules = (
			await this.gcloud(['compute', 'firewall-rules', 'list', `--filter=name~^mc-${runId}-`, '--format=value(name)'])
		)
			.split('\n')
			.filter(Boolean);
		for (const rule of rules) {
			log(`cleanup: deleting firewall rule ${rule}`);
			await this.gcloud(['compute', 'firewall-rules', 'delete', rule]);
		}
		const disks = (
			await this.gcloud(['compute', 'disks', 'list', `--filter=name~^mc-${runId}-`, '--format=value(name)'])
		)
			.split('\n')
			.filter(Boolean);
		if (disks.length > 0) {
			log(`cleanup: deleting leftover disks ${disks.join(', ')}`);
			await this.gcloud(['compute', 'disks', 'delete', ...disks, `--zone=${zone}`]);
		}
		const remaining = [
			...(
				await this.gcloud(['compute', 'instances', 'list', `--filter=labels.run=${runId}`, '--format=value(name)'])
			).split('\n'),
			...(await this.gcloud(['compute', 'disks', 'list', `--filter=name~^mc-${runId}-`, '--format=value(name)'])).split(
				'\n'
			),
			...(
				await this.gcloud(['compute', 'firewall-rules', 'list', `--filter=name~^mc-${runId}-`, '--format=value(name)'])
			).split('\n'),
		].filter(Boolean);
		if (remaining.length > 0) throw new Error(`cleanup incomplete; still present: ${remaining.join(', ')}`);
		this.manifest.state = 'cleaned';
		await this.saveManifest();
		log(`cleanup: run ${runId} has no instances, disks or firewall rules left in ${this.options.project}`);
	}
}

export async function verifyChecksums(dir: string): Promise<void> {
	const sums = await readFile(join(dir, 'SHA256SUMS'), 'utf8');
	for (const line of sums.split('\n').filter(Boolean)) {
		const [expected, name] = line.split(/\s+/);
		const actual = createHash('sha256')
			.update(await readFile(join(dir, name)))
			.digest('hex');
		if (actual !== expected) throw new Error(`checksum mismatch for ${join(dir, name)}`);
	}
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const launcher = new Launcher(options);
	if (options.command === 'report') {
		log(`report: ${await writeReport(launcher.runDir)}`);
		return;
	}
	if (options.command === 'cleanup') {
		await launcher.loadManifest();
		await launcher.cleanup();
		return;
	}
	if (options.command === 'status') {
		await launcher.loadManifest();
		for (const pair of launcher.manifest.pairs) {
			const state = await launcher.pairState(pair.client.externalIp!);
			log(
				`${pair.name}: ${state.marker ?? state.status.phase ?? '?'} ${state.status.done ?? 0}/${state.status.total ?? '?'} alive=${state.alive}`
			);
		}
		return;
	}
	const plans = planProfile(options.profile, options.pairs);
	for (const plan of plans) {
		log(
			`plan ${plan.name}: ${plan.records} records, ${plan.calibrations.length} calibrations, ${plan.cells.length} cells, ~${estimatedHours(plan).toFixed(1)} h`
		);
		const longest = estimatedHours(plan);
		if (longest > options.maxRunHours - 2)
			throw new Error(
				`${plan.name} needs ~${longest.toFixed(1)} h, over --max-run-hours ${options.maxRunHours} minus margin`
			);
	}
	if (options.dryRun) return;
	if (options.command === 'run') {
		await mkdir(join(HERE, 'runs'), { recursive: true });
		// Non-recursive, so two launches with one run id cannot both own it.
		await mkdir(launcher.runDir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== 'EEXIST') throw error;
			throw new Error(
				`run ${options.runId} already exists; use resume, status or cleanup for it, or pick another --run-id`
			);
		});
	}
	if (options.command === 'resume') {
		await launcher.loadManifest();
		// Refused before the try, so the refusal never reaches the cleanup in its finally.
		if (!launcher.manifest.pairs.some((pair) => pair.started)) {
			throw new Error(`run ${options.runId} never started measuring; delete it with cleanup and start a new run`);
		}
	}
	let finished = false;
	try {
		if (options.command === 'run') {
			const tarball = await launcher.sourceTarball();
			await launcher.create(plans);
			await launcher.provision(plans, tarball);
			for (const pair of launcher.manifest.pairs) await launcher.startOrchestrator(pair);
			launcher.manifest.state = 'running';
			await launcher.saveManifest();
		} else {
			for (const pair of launcher.manifest.pairs) {
				// A resumed pair is polled afresh: a lost client may be reachable again, and an earlier partial copy is stale.
				if (pair.outcome === 'lost' || pair.outcome === 'crashed') pair.outcome = undefined;
				if (pair.saved === 'partial') pair.saved = undefined;
			}
			await launcher.refreshSshSource();
			await launcher.refreshAddresses();
		}
		await launcher.waitForPairs();
		launcher.manifest.state = 'fetched';
		await launcher.saveManifest();
		finished = true;
		log(`report: ${await writeReport(launcher.runDir)}`);
		const failed = launcher.manifest.pairs.filter((pair) => pair.outcome !== 'DONE').map((pair) => pair.name);
		if (failed.length > 0) {
			log(`pairs that did not complete: ${failed.join(', ')} (see their orchestrate.log)`);
			process.exitCode = 1;
		}
	} finally {
		if (!options.keep && existsSync(join(launcher.runDir, 'manifest.json'))) {
			const retry = `node benchmarks/memory-curve/run.mts resume --run-id ${options.runId} --project ${options.project}`;
			try {
				if (!launcher.manifest) await launcher.loadManifest();
				// Before the orchestrators start, the VMs hold nothing measured.
				const measuring = launcher.manifest.pairs.some((pair) => pair.started);
				if (!finished && measuring) await launcher.fetchPartial();
				const unsaved = measuring ? launcher.unsavedPairs() : [];
				if (unsaved.length > 0) {
					log(
						`keeping the run's resources: results of ${unsaved.join(', ')} exist only on their VMs (which delete themselves ` +
							`${launcher.manifest.maxRunHours} h after creation). Retry with: ${retry}; or discard with the cleanup command.`
					);
				} else {
					await launcher.cleanup();
				}
			} catch (error) {
				log(
					`cleanup FAILED: ${(error as Error).message}; rerun: node benchmarks/memory-curve/run.mts cleanup --run-id ${options.runId} --project ${options.project}`
				);
				process.exitCode = 1;
			}
		}
	}
}

if (import.meta.main) await main();
