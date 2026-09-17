/**
 * Coverage for `closeOnInboundMessageError` — the inbound-handler error path in `replicateOverWS`.
 *
 * An error escaping `onWSMessage` used to be logged and swallowed, silently dropping the rest of
 * the failed frame while later frames kept applying and confirming higher sequence ids — a
 * permanent, undetected gap (harper-pro#440, epic #430 Theme B). These tests pin the recovery
 * contract: inbound processing is latched off BEFORE the socket close (frames already queued on
 * the messageProcessing chain must not commit past the hole), and the close is a transient
 * 1011 (no `intentional` flag) so the normal retry path reconnects and resumes from the durable
 * cursor.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import { closeOnInboundMessageError } from '#src/replication/replicationConnection';

describe('closeOnInboundMessageError', () => {
	it('latches inbound processing off before closing the socket', () => {
		const markInboundClosed = sinon.spy();
		const close = sinon.spy();

		closeOnInboundMessageError(new Error('boom'), {
			connectionId: 7,
			logger: { error: sinon.spy() },
			markInboundClosed,
			close,
		});

		expect(markInboundClosed.calledOnce).to.equal(true);
		expect(close.calledOnce).to.equal(true);
		expect(markInboundClosed.calledBefore(close)).to.equal(true);
	});

	it('closes with 1011 (internal error, transient — reconnect path)', () => {
		const close = sinon.spy();

		closeOnInboundMessageError(new Error('boom'), {
			connectionId: 7,
			logger: {},
			markInboundClosed: () => {},
			close,
		});

		const [code, reason] = close.firstCall.args;
		expect(code).to.equal(1011);
		expect(reason).to.be.a('string').and.to.have.length.greaterThan(0);
	});

	it('logs the original error with the connection id', () => {
		const error = new Error('malformed frame');
		const logError = sinon.spy();

		closeOnInboundMessageError(error, {
			connectionId: 'conn-42',
			logger: { error: logError },
			markInboundClosed: () => {},
			close: () => {},
		});

		expect(logError.calledOnce).to.equal(true);
		expect(logError.firstCall.args[0]).to.equal('conn-42');
		expect(logError.firstCall.args).to.include(error);
	});

	it('still closes when the logger has no error level (optional chaining)', () => {
		const close = sinon.spy();

		closeOnInboundMessageError(new Error('boom'), {
			connectionId: 7,
			logger: {},
			markInboundClosed: () => {},
			close,
		});

		expect(close.calledOnce).to.equal(true);
	});

	it('still closes when the logger itself is missing — the log must never prevent the close', () => {
		const close = sinon.spy();

		closeOnInboundMessageError(new Error('boom'), {
			connectionId: 7,
			logger: undefined,
			markInboundClosed: () => {},
			close,
		});

		expect(close.calledOnce).to.equal(true);
	});
});
