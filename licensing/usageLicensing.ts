import type { Logger } from '../core/utility/logging/logger.ts';
import { type ValidatedLicense, validateLicense, initPublicKey } from './validation.ts';
import { ClientError } from '../core/utility/errors/hdbError.js';
import { onAnalyticsAggregate } from '../core/resources/analytics/write.ts';
import { transaction } from '../core/resources/transaction.ts';
import { databases } from '../core/resources/databases.ts';
import { watch } from 'chokidar';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as configUtils from '../core/config/configUtils.js';
import * as terms from '../core/utility/hdbTerms.ts';
import type { Server } from '../core/server/Server.ts';
import type { Scope } from '../core/components/Scope.ts';
import { universalHeaders } from '../core/server/http.ts';

//
export const suppressHandleApplicationWarning = true;

let logger: Logger;

class ExistingLicenseError extends Error {}

interface InstallLicenseRequest {
	operation: 'install_usage_license';
	license: string;
}

interface UsageLicense extends ValidatedLicense {
	usedReads?: number;
	usedReadBytes?: number;
	usedWrites?: number;
	usedWriteBytes?: number;
	usedRealTimeMessages?: number;
	usedRealTimeBytes?: number;
	usedCpuTime?: number;
	usedStorage?: number;
}

interface GetUsageLicenseParams {
	region?: string;
}

interface GetUsageLicensesReq extends GetUsageLicenseParams {
	operation: 'get_usage_licenses';
}

let licenseRegion: string | undefined;
let licenseConsoleErrorPrinted = false;
let licenseWarningIntervalId: NodeJS.Timeout | undefined;
const LICENSE_NAG_PERIOD = 600000; // ten minutes

export function handleApplication({ server, logger, options }: Scope) {
	const region = options.get(terms.CONFIG_PARAMS.LICENSE_REGION.split('_')) as string;
	const mode = options.get(terms.CONFIG_PARAMS.LICENSE_MODE.split('_')) as string;
	initUsageLicensing({ server, logger, license: { region, mode } });
}

interface LicenseParams {
	region: string;
	mode: string;
}

interface UsageLicensingInitParams {
	server: Server;
	logger: Logger;
	license: LicenseParams;
}

export function initUsageLicensing(params: UsageLicensingInitParams) {
	logger = params.logger;

	initPublicKey(params.license.mode);

	licenseRegion = params.license.region;

	onAnalyticsAggregate(recordUsage);

	server.registerOperation?.({
		name: 'install_usage_license',
		execute: installUsageLicenseOp,
		httpMethod: 'POST',
	});

	server.registerOperation?.({
		name: 'get_usage_licenses',
		execute: getUsageLicensesOp,
		httpMethod: 'GET',
	});

	const licensesPath = path.join(path.dirname(configUtils.getConfigFilePath()), 'licenses');
	const watchOptions = {
		persistent: false,
		ignoreInitial: false,
		depth: 0,
		ignored: (file: string, stats: Stats) => stats?.isFile() && !file.endsWith('.txt'),
	};
	watch(licensesPath, watchOptions).on('add', loadLicenseFile);
}

async function installUsageLicenseOp(req: InstallLicenseRequest): Promise<string> {
	const license = req.license;
	try {
		await installUsageLicense(license);
	} catch (cause) {
		const error = new ClientError('Failed to install usage license; ' + cause.message);
		error.cause = cause;
		throw error;
	}
	return 'Successfully installed usage license';
}

async function installUsageLicense(license: string): Promise<void> {
	const validatedLicense = validateLicense(license);
	const { id } = validatedLicense;
	const existingLicense = await databases.system.hdb_license.get(id);
	if (existingLicense) {
		throw new ExistingLicenseError(`A usage license with ${id} already exists`);
	}
	logger.info?.('Installing usage license:', validatedLicense);
	return databases.system.hdb_license.put(id, validatedLicense);
}

export function isActiveLicense(license: UsageLicense): boolean {
	return (
		(license.reads === -1 || (license.usedReads ?? 0) < license.reads) &&
		(license.readBytes === -1 || (license.usedReadBytes ?? 0) < license.readBytes) &&
		(license.writes === -1 || (license.usedWrites ?? 0) < license.writes) &&
		(license.writeBytes === -1 || (license.usedWriteBytes ?? 0) < license.writeBytes) &&
		(license.realTimeMessages === -1 || (license.usedRealTimeMessages ?? 0) < license.realTimeMessages) &&
		(license.realTimeBytes === -1 || (license.usedRealTimeBytes ?? 0) < license.realTimeBytes) &&
		(license.cpuTime === -1 || (license.usedCpuTime ?? 0) < license.cpuTime) &&
		(license.storage === -1 || (license.usedStorage ?? 0) < license.storage)
	);
}

export async function getActiveLicense(): Promise<UsageLicense | undefined> {
	const licenseQuery = {
		sort: { attribute: '__createdtime__' },
		conditions: [{ attribute: 'expiration', comparator: 'greater_than', value: new Date().toISOString() }],
	};
	if (licenseRegion !== undefined) {
		licenseQuery.conditions.push({ attribute: 'region', comparator: 'equals', value: licenseRegion });
	}
	const results = databases.system.hdb_license?.search(licenseQuery as any);
	for await (const license of results ?? []) {
		if (isActiveLicense(license)) {
			return license;
		}
	}
	return undefined;
}

export async function isLicensed(): Promise<boolean> {
	const activeLicense = await getActiveLicense();
	return activeLicense !== undefined;
}

async function recordUsage(analytics: any) {
	logger.trace?.('Recording usage into license from analytics');
	const activeLicenseId = (await getActiveLicense())?.id;
	if (activeLicenseId) {
		logger.trace?.('Found license to record usage into:', activeLicenseId);
		const context: any = {};
		transaction(context, () => {
			const updatableActiveLicense = databases.system.hdb_license.update(activeLicenseId, context);
			for (const analyticsRecord of analytics) {
				logger.trace?.('Processing analytics record:', analyticsRecord);
				switch (analyticsRecord.metric) {
					case 'db-read':
						logger.trace?.('Recording read usage into license');
						updatableActiveLicense.addTo('usedReads', analyticsRecord.count);
						updatableActiveLicense.addTo('usedReadBytes', analyticsRecord.mean * analyticsRecord.count);
						break;
					case 'db-write':
						logger.trace?.('Recording write usage into license');
						updatableActiveLicense.addTo('usedWrites', analyticsRecord.count);
						updatableActiveLicense.addTo('usedWriteBytes', analyticsRecord.mean * analyticsRecord.count);
						break;
					case 'db-message':
						logger.trace?.('Recording message usage into license');
						updatableActiveLicense.addTo('usedRealTimeMessages', analyticsRecord.count);
						updatableActiveLicense.addTo('usedRealTimeBytes', analyticsRecord.mean * analyticsRecord.count);
						break;
					case 'cpu-usage':
						if (analyticsRecord.path === 'user') {
							logger.trace?.('Recording CPU usage into license');
							updatableActiveLicense.addTo('usedCpuTime', (analyticsRecord.mean * analyticsRecord.count) / 3600);
						}
						break;
					default:
						logger.trace?.('Skipping metric:', analyticsRecord.metric);
				}
			}
		});
		universalHeaders.splice(0, universalHeaders.length); // clear out any previous license nag headers
		if (licenseWarningIntervalId !== undefined) {
			clearInterval(licenseWarningIntervalId);
			licenseWarningIntervalId = undefined;
			licenseConsoleErrorPrinted = false;
		}
	} else {
		// assign license nag header
		universalHeaders.splice(
			0,
			universalHeaders.length,
			'X-License-Info',
			'Unlicensed Harper Pro, this should only be used for educational and development purposes'
		);
		if (!process.env.DEV_MODE) {
			const msg =
				'This server does not have valid usage licenses, this should only be used for educational and development purposes.';
			if (!licenseConsoleErrorPrinted) {
				console.error(msg);
				licenseConsoleErrorPrinted = true;
			}
			if (licenseWarningIntervalId === undefined) {
				licenseWarningIntervalId = setInterval(() => {
					logger.notify?.(msg);
				}, LICENSE_NAG_PERIOD).unref();
			}
		}
	}
}

function getUsageLicensesOp(req: GetUsageLicensesReq): AsyncIterable<UsageLicense> {
	const params: GetUsageLicenseParams = {};
	if (req.region) {
		params.region = req.region;
	}
	return getUsageLicenses(params);
}

export function getUsageLicenses(params?: GetUsageLicenseParams): AsyncIterable<UsageLicense> {
	const conditions = [];
	const attrs = typeof params === 'object' ? Object.keys(params) : [];
	if (attrs.length > 0) {
		attrs.forEach((attribute) => {
			conditions.push({ attribute, comparator: 'equals', value: params[attribute] });
		});
	}
	return databases.system.hdb_license.search({
		sort: { attribute: '__createdtime__' },
		conditions,
	} as any);
}

async function loadLicenseFile(filePath: string) {
	logger.trace?.('Loading usage license from file:', filePath);
	const encodedLicense = await fs.readFile(filePath, { encoding: 'utf-8' });
	try {
		await installUsageLicense(encodedLicense);
	} catch (err) {
		logger.error?.('Failed to install usage license from file:', filePath, err);
	}
}
