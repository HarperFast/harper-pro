import { setCertTable } from '../core/security/keys.js';
import { createCsr, signCertificate, getReplicationCert, getReplicationCertAuth } from '../security/certificate.ts';
import { validateBySchema } from '../core/validation/validationWrapper.js';
import Joi from 'joi';
const { pki } = require('node-forge');
import { get } from '../core/utility/environment/environmentManager.js';
import { OPERATIONS_ENUM, CONFIG_PARAMS } from '../core/utility/hdbTerms.ts';
import { ensureNode } from './subscriptionManager.ts';
import { getHDBNodeTable } from './knownNodes.ts';
import { sendOperationToNode, urlToNodeName } from './replicator.ts';
import { getThisNodeName, hostnameToUrl, getThisNodeUrl } from '../core/server/nodeName.ts';
import * as hdbLogger from '../core/utility/logging/harper_logger.js';
import { handleHDBError, hdbErrors, ClientError } from '../core/utility/errors/hdbError.js';
import { server } from '../core/server/Server.ts';
const { HTTP_STATUS_CODES } = hdbErrors;

const validationSchema = Joi.object({
	hostname: Joi.string(),
	verify_tls: Joi.boolean(),
	replicates: Joi.boolean(),
	subscriptions: Joi.array(),
	revoked_certificates: Joi.array(),
	shard: Joi.number(),
});

/**
 * Can add, update or remove a node from replication
 * @param req
 */
export async function setNode(req: any) {
	if (req.node_name && !req.hostname) req.hostname = req.node_name;
	if (req.verify_tls !== undefined) req.rejectUnauthorized = req.verify_tls;
	let { url, hostname } = req;
	if (!url) url = hostnameToUrl(hostname);
	else if (!hostname) hostname = req.hostname = urlToNodeName(url);
	const validation = validateBySchema(req, validationSchema);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	if (req.operation === 'remove_node') {
		if (!url && !hostname) throw new ClientError('url or hostname is required for remove_node operation');
		const nodeRecordId = hostname;
		const hdbNodes = getHDBNodeTable();
		const record = await hdbNodes.get(nodeRecordId);
		if (!record) throw new ClientError(nodeRecordId + ' does not exist');

		try {
			// we delete record and req that other node also deletes record (or mark itself as non-replicating)
			// we do not wait for the other node to respond, it may not even be online anymore
			await sendOperationToNode(
				{ url: record.url },
				{
					operation: 'remove_node_back',
					name:
						record?.subscriptions?.length > 0
							? getThisNodeName() // if we are doing a removal with explicit subscriptions, we want to the other node to remove the record for this node
							: nodeRecordId, // if we are doing a removal with full replication, we want the other node to remove its own record to indicate it is not replicating
				},
				undefined
			);
		} catch (err) {
			hdbLogger.warn(
				`Error removing node from target node ${nodeRecordId}, if it is offline and we be online in the future, you may need to clean up this node manually, or retry:`,
				err
			);
		}

		await hdbNodes.delete(nodeRecordId);

		return `Successfully removed '${nodeRecordId}' from cluster`;
	}

	if (!url) throw new ClientError('url required for this operation');

	const thisUrl = getThisNodeUrl();
	if (thisUrl == null) throw new ClientError('replication url is missing from harperdb-config.yaml');

	let rep;
	let csr;
	let csrPrivateKeyName;
	let cert_auth;
	if (url?.startsWith('wss:')) {
		rep = await getReplicationCert();
		const caRecord = await getReplicationCertAuth();
		if (!rep) throw new Error('Unable to find a certificate to use for replication');
		if (rep.options.is_self_signed || req.force_signing) {
			// Create the certificate signing request that will be sent to the other node
			const csrResult = await createCsr();
			csr = csrResult.pem;
			csrPrivateKeyName = csrResult.privateKeyName;
			hdbLogger.info('Sending CSR to target node:', url);
		} else if (caRecord) {
			cert_auth = caRecord.certificate;
			hdbLogger.info('Sending CA named', caRecord.name, 'to target node', url);
		}
	}

	// This is the record that will be added to the other nodes hdbNodes table
	const targetAddNodeObj = {
		operation: 'add_node_back',
		hostname: getThisNodeName(),
		target_hostname: hostname,
		url: thisUrl,
		csr,
		cert_auth,
		authorization: req.retain_authorization ? req.authorization : null,
	};
	if (get(CONFIG_PARAMS.REPLICATION_SHARD) !== undefined) targetAddNodeObj.shard = get(CONFIG_PARAMS.REPLICATION_SHARD);

	if (req.subscriptions) {
		targetAddNodeObj.subscriptions = req.subscriptions.map(reverseSubscription);
	} else targetAddNodeObj.subscriptions = null;

	if (req.hasOwnProperty('subscribe') || req.hasOwnProperty('publish')) {
		const rev = reverseSubscription(req);
		targetAddNodeObj.subscribe = rev.subscribe;
		targetAddNodeObj.publish = rev.publish;
	}

	if (req?.authorization?.username && req?.authorization?.password) {
		req.authorization =
			'Basic ' + Buffer.from(req.authorization.username + ':' + req.authorization.password).toString('base64');
	}

	let targetNodeResponse: any;
	let targetNodeResponseError: Error;
	hdbLogger.notify('sending add_node_back operation', targetAddNodeObj);
	try {
		targetNodeResponse = await sendOperationToNode({ url }, targetAddNodeObj, req);
	} catch (err) {
		err.message = `Error returned from ${url}: ` + err.message;
		hdbLogger.warn('Error adding node:', url, 'to cluster:', err);
		targetNodeResponseError = err;
	}

	if (csr && (!targetNodeResponse?.certificate || !targetNodeResponse?.certificate?.includes?.('BEGIN CERTIFICATE'))) {
		if (targetNodeResponseError) {
			targetNodeResponseError.message += ' and connection was required to sign certificate';
			throw targetNodeResponseError;
		}
		throw new Error(
			`Unexpected certificate signature response from node ${url} response: ${JSON.stringify(targetNodeResponse)}`
		);
	}

	if (csr) {
		hdbLogger.info('CSR response received from node:', url, 'saving certificate and CA in hdb_certificate');

		await setCertTable({
			name: pki.certificateFromPem(targetNodeResponse.signingCA).issuer.getField('CN').value,
			certificate: targetNodeResponse.signingCA,
			is_authority: true,
		});

		if (targetNodeResponse.certificate) {
			await setCertTable({
				// give it a different name so we don't interfere with existing certificates
				name: `${getThisNodeName()}-replication`,
				uses: ['replication'],
				certificate: targetNodeResponse.certificate,
				private_key_name: csrPrivateKeyName ?? rep?.options?.key_file,
				is_authority: false,
				is_self_signed: false,
			});
		}
		cert_auth = targetNodeResponse.signingCA;
	}

	const nodeRecord = { url, ca: targetNodeResponse?.usingCA };
	if (req.hostname) nodeRecord.name = req.hostname;
	if (req.subscriptions) nodeRecord.subscriptions = req.subscriptions;
	else nodeRecord.replicates = true;
	if (req.start_time) {
		nodeRecord.start_time = typeof req.start_time === 'string' ? new Date(req.start_time).getTime() : req.start_time;
	}
	if (req.retain_authorization) nodeRecord.authorization = req.authorization;
	if (req.revoked_certificates) nodeRecord.revoked_certificates = req.revoked_certificates;
	if (targetNodeResponse?.shard !== undefined) nodeRecord.shard = targetNodeResponse.shard;
	else if (req.shard !== undefined) nodeRecord.shard = req.shard;

	if (nodeRecord.replicates) {
		const thisNode = {
			url: thisUrl,
			ca: cert_auth,
			replicates: true,
			subscriptions: null,
		};
		if (get(CONFIG_PARAMS.REPLICATION_SHARD) !== undefined) thisNode.shard = get(CONFIG_PARAMS.REPLICATION_SHARD);

		if (req.retain_authorization) thisNode.authorization = req.authorization;
		if (req.start_time) thisNode.start_time = req.start_time;
		await ensureNode(getThisNodeName(), thisNode);
	}
	await ensureNode(
		targetNodeResponse ? targetNodeResponse.nodeName : (nodeRecord.name ?? urlToNodeName(url)),
		nodeRecord
	);
	let message: string;
	if (req.operation === 'update_node') {
		message = `Successfully updated '${url}'`;
	} else message = `Successfully added '${url}' to cluster`;
	if (targetNodeResponseError)
		message += ' but there was an error updating target node: ' + targetNodeResponseError.message;
	return message;
}

/**
 * Is called by other node when an add_node operation is requested
 * @param req
 */
export async function addNodeBack(req) {
	hdbLogger.trace('addNodeBack received request:', req);

	let certs = {};
	// If the add_node req has a CSR attached, return the CA that was used to issue the CSR,
	// else return whatever CA this node is using for replication
	let originCa: string;
	if (!req.csr) {
		// If there is no CSR in the request there should be a CA, use this CA in the hdbNodes record for origin node
		originCa = req?.cert_auth;
		hdbLogger.info('addNodeBack received CA from node:', req.url);
	} else {
		certs = await signCertificate(req);
		originCa = certs.signingCA;
		hdbLogger.info(
			'addNodeBack received CSR from node:',
			req.url,
			'this node will use and respond with CA that was used to issue CSR'
		);
	}

	const nodeRecord = { url: req.url, ca: originCa };
	if (req.subscriptions) nodeRecord.subscriptions = req.subscriptions;
	else {
		nodeRecord.replicates = true;
		nodeRecord.subscriptions = null;
	}

	if (req.start_time) nodeRecord.start_time = req.start_time;
	if (req.authorization) nodeRecord.authorization = req.authorization;
	if (req.shard !== undefined) nodeRecord.shard = req.shard;

	const repCa = await getReplicationCertAuth();
	if (nodeRecord.replicates) {
		const thisNode = {
			url: getThisNodeUrl(),
			ca: repCa?.certificate,
			replicates: true,
			subscriptions: null,
		};
		if (get(CONFIG_PARAMS.REPLICATION_SHARD) !== undefined) {
			thisNode.shard = get(CONFIG_PARAMS.REPLICATION_SHARD);
			certs.shard = thisNode.shard;
		}

		if (req.start_time) thisNode.start_time = req.start_time;
		if (req.authorization) thisNode.authorization = req.authorization;
		await ensureNode(getThisNodeName(), thisNode);
	}
	await ensureNode(req.hostname, nodeRecord);
	certs.nodeName = getThisNodeName();

	certs.usingCA = repCa?.certificate; // in addition to the signed CA, we need to return the CA that is being used for the active certificate
	hdbLogger.info('addNodeBack responding to:', req.url, 'with CA named:', repCa?.name);

	return certs;
}

/**
 * Is called by other node when remove_node is requested and
 * system tables are not replicating
 */
export async function removeNodeBack(req) {
	hdbLogger.trace('removeNodeBack received request:', req);
	const hdbNodes = getHDBNodeTable();
	//  delete the record
	await hdbNodes.delete(req.name);
}

function reverseSubscription(subscription) {
	const { subscribe, publish } = subscription;
	return { ...subscription, subscribe: publish, publish: subscribe };
}
server.registerOperation?.({
	name: 'set_node',
	execute: setNode,
	httpMethod: 'PUT',
	parametersSchema: [{ name: 'hostname', in: 'path', schema: { type: 'string' } }],
});
server.registerOperation?.({
	name: 'add_node',
	execute: setNode,
	httpMethod: 'PUT',
	parametersSchema: [{ name: 'hostname', in: 'path', schema: { type: 'string' } }],
});
server.registerOperation?.({
	name: 'add_node_back',
	execute: addNodeBack,
	httpMethod: 'PUT',
	parametersSchema: [{ name: 'hostname', in: 'path', schema: { type: 'string' } }],
});
server.registerOperation?.({
	name: 'remove_node_back;',
	execute: removeNodeBack,
	httpMethod: 'DELETE',
});
server.registerOperation?.({
	name: 'remove_node',
	execute: setNode,
	httpMethod: 'DELETE',
	parametersSchema: [{ name: 'hostname', in: 'path', schema: { type: 'string' } }],
});
