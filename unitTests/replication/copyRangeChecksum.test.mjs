/**
 * Coverage for the resume-range checksum helpers (#537 follow-up). On a copy resume the sender
 * checksums the range the follower's cursor claims was already delivered (keys only, primary-key
 * order, local-only records excluded) and ships it on COPY_START; the follower computes the same
 * over its own tables and alerts on mismatch. These helpers are the deterministic core: equal
 * ordered key ranges must always agree, any difference must show, and capped scans must stay
 * comparable because both sides cap at the same count over the same order.
 */

import { expect } from 'chai';
import {
	createRangeChecksum,
	compareRangeChecksums,
	checksumTableRange,
	RANGE_CHECKSUM_MAX_KEYS,
} from '#src/replication/replicationConnection';

function checksumOf(keys, maxKeys) {
	const checksum = createRangeChecksum(maxKeys);
	for (const key of keys) checksum.add(key);
	return checksum.result();
}

describe('createRangeChecksum', () => {
	it('is deterministic for the same ordered keys', () => {
		expect(checksumOf(['a', 'b', 'c'])).to.deep.equal(checksumOf(['a', 'b', 'c']));
	});

	it('is order-sensitive', () => {
		expect(checksumOf(['a', 'b'])).to.not.deep.equal(checksumOf(['b', 'a']));
	});

	it('separates key boundaries', () => {
		expect(checksumOf(['ab', 'c'])).to.not.deep.equal(checksumOf(['a', 'bc']));
	});

	it('hashes non-string keys canonically', () => {
		expect(checksumOf([1, [2, 'x']])).to.deep.equal(checksumOf([1, [2, 'x']]));
	});

	it('keeps key types distinct: number 1, string 1, BigInt 1n', () => {
		expect(checksumOf([1])).to.not.deep.equal(checksumOf(['1']));
		expect(checksumOf([1])).to.not.deep.equal(checksumOf([1n]));
		expect(checksumOf(['1'])).to.not.deep.equal(checksumOf([1n]));
	});

	it('accepts BigInt keys without throwing (ordered-binary yields BigInt past 2^53)', () => {
		expect(checksumOf([2n ** 60n, 2n ** 60n + 1n]).count).to.equal(2);
	});

	it('resists boundary shifts even with the terminator inside a key', () => {
		expect(checksumOf(['a\u001f', 'b'])).to.not.deep.equal(checksumOf(['a', '\u001fb']));
	});

	it('counts exactly and starts empty', () => {
		expect(checksumOf([]).count).to.equal(0);
		expect(checksumOf(['a', 'b', 'c']).count).to.equal(3);
		expect(checksumOf([]).capped).to.equal(false);
	});

	it('caps at maxKeys, flags it, and rejects further keys', () => {
		const checksum = createRangeChecksum(2);
		expect(checksum.add('a')).to.equal(true);
		expect(checksum.add('b')).to.equal(true);
		expect(checksum.add('c')).to.equal(false);
		expect(checksum.result()).to.include({ count: 2, capped: true });
	});

	it('capped checksums stay comparable when both sides cap over the same order', () => {
		expect(checksumOf(['a', 'b', 'c', 'd'], 2)).to.deep.equal(checksumOf(['a', 'b', 'z', 'q'], 2));
	});

	it('exposes a sane default cap', () => {
		expect(RANGE_CHECKSUM_MAX_KEYS).to.be.greaterThan(0);
	});

	it('matches the golden vector (sender and receiver must compute identical hashes across versions)', () => {
		// Pins the exact wire values: any change to the canonical key form, the length mix, either
		// lane's seed/prime/shift, or the terminator changes these numbers and breaks mixed-version
		// comparability. If this test fails, the checksum algorithm changed; that requires a new
		// message id (or a version field), not just new constants.
		expect(checksumOf(['alpha', 42, ['tenant', 7n], 'omega'])).to.deep.equal({
			count: 4,
			h1: 2319132405,
			h2: 719383003,
			capped: false,
		});
	});
});

describe('compareRangeChecksums', () => {
	const sum = (keys) => checksumOf(keys);

	it('reports nothing when every table matches', () => {
		expect(compareRangeChecksums({ dogs: sum(['a', 'b']) }, { dogs: sum(['a', 'b']) })).to.deep.equal([]);
	});

	it('reports a count difference', () => {
		const mismatches = compareRangeChecksums({ dogs: sum(['a', 'b']) }, { dogs: sum(['a']) });
		expect(mismatches).to.have.length(1);
		expect(mismatches[0].table).to.equal('dogs');
		expect(mismatches[0].sent.count).to.equal(2);
		expect(mismatches[0].local.count).to.equal(1);
	});

	it('reports a content difference at equal counts', () => {
		expect(compareRangeChecksums({ dogs: sum(['a', 'b']) }, { dogs: sum(['a', 'c']) })).to.have.length(1);
	});

	it('skips tables the receiver did not compute', () => {
		expect(compareRangeChecksums({ dogs: sum(['a']) }, {})).to.deep.equal([]);
	});

	it('ignores malformed sender entries', () => {
		expect(
			compareRangeChecksums(
				{ dogs: null, cats: 7, fish: { count: 'x' } },
				{ dogs: sum([]), cats: sum([]), fish: sum([]) }
			)
		).to.deep.equal([]);
	});

	it('flags a capped/uncapped disagreement', () => {
		const capped = checksumOf(['a', 'b', 'c'], 2);
		const uncapped = { ...checksumOf(['a', 'b', 'c'], 2), capped: false };
		expect(compareRangeChecksums({ dogs: capped }, { dogs: uncapped })).to.have.length(1);
	});
});

describe('checksumTableRange', () => {
	// Mock store: applies the end/inclusiveEnd bound over string keys like a real range scan would.
	function storeOf(entries) {
		const captured = [];
		return {
			captured,
			getRange(options) {
				captured.push(options);
				return entries.filter(
					(entry) =>
						options.end === undefined || entry.key < options.end || (options.inclusiveEnd && entry.key === options.end)
				);
			},
		};
	}
	const expected = (keys) => {
		const checksum = createRangeChecksum();
		for (const key of keys) checksum.add(key);
		return checksum.result();
	};

	it('checksums the whole table when no end is given', async () => {
		const store = storeOf([{ key: 'a' }, { key: 'b' }, { key: 'c' }]);
		expect(await checksumTableRange(store, {})).to.deep.equal(expected(['a', 'b', 'c']));
		expect(store.captured[0].snapshot).to.equal(false);
	});

	it('bounds the resume table through end inclusive', async () => {
		const store = storeOf([{ key: 'a' }, { key: 'b' }, { key: 'c' }]);
		expect(await checksumTableRange(store, { end: 'b' })).to.deep.equal(expected(['a', 'b']));
		expect(store.captured[0]).to.include({ end: 'b', inclusiveEnd: true });
	});

	it('excludes local-only records like the copy does', async () => {
		// all flag bits set, so whatever bit LOCAL_ONLY is, this entry carries it
		const store = storeOf([{ key: 'a' }, { key: 'b', metadataFlags: 0xffffffff }, { key: 'c' }]);
		const result = await checksumTableRange(store, {});
		expect(result.count).to.equal(2);
		expect(result).to.deep.equal(expected(['a', 'c']));
	});

	it('caps at maxKeys and flags it', async () => {
		const store = storeOf([{ key: 'a' }, { key: 'b' }, { key: 'c' }]);
		const result = await checksumTableRange(store, { maxKeys: 2 });
		expect(result).to.include({ count: 2, capped: true });
	});

	it('aborts to undefined when the connection closes mid-scan', async () => {
		let seen = 0;
		const store = {
			getRange() {
				return {
					*[Symbol.iterator]() {
						for (const key of ['a', 'b', 'c']) {
							seen++;
							yield { key };
						}
					},
				};
			},
		};
		expect(await checksumTableRange(store, { isClosed: () => seen >= 2 })).to.equal(undefined);
	});
});
