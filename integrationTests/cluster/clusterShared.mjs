import { equal } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Send an operation to a Harper node and validate the response
 * @param {Object} node - The Harper node instance
 * @param {Object} operation - The operation to send
 * @returns {Promise<Object>} The response data
 */
export async function sendOperation(node, operation) {
	const response = await fetch(node.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(operation),
	});
	const responseData = await response.json();
	equal(response.status, 200, JSON.stringify(responseData));
	return responseData;
}

/**
 * Fetch a URL with automatic retry logic
 * @param {string} url - The URL to fetch
 * @param {Object} [options] - Fetch options
 * @param {number} [options.retries=20] - Number of retries
 * @returns {Promise<Response>} The fetch response
 */
export function fetchWithRetry(url, options) {
	let retries = options?.retries ?? 20;
	let response = fetch(url, options);
	if (retries > 0) {
		response = response.catch(() => {
			options ??= {};
			options.retries = retries - 1;
			return delay(500).then(() => fetchWithRetry(url, options));
		});
	}
	return response;
}

/**
 * Execute tasks concurrently with a concurrency limit
 * @param {Function} task - The task to execute
 * @param {number} [concurrency=100] - Maximum number of concurrent tasks
 * @returns {Object} Object with execute and finish methods
 */
export function concurrent(task, concurrency = 20) {
	let tasks = new Array(concurrency);
	let i = 0;
	return {
		async execute() {
			i = (i + 1) % concurrency;
			await tasks[i];
			tasks[i] = task();
		},
		finish() {
			return Promise.all(tasks);
		},
	};
}
