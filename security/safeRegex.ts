import RE2 from 're2';

/**
 * Compile an operator- or attacker-influenced regex source with RE2 instead of `new RegExp(...)`.
 *
 * RE2 is a finite-automaton engine with a linear-time matching guarantee: a pathological pattern
 * such as `(a+)+$` cannot trigger catastrophic backtracking and stall the event loop the way the
 * built-in `RegExp` can (ReDoS). Any regex whose source is not fully trusted should be compiled
 * through here rather than through `RegExp`.
 *
 * The signature mirrors an error-collecting validator: on success it returns the compiled matcher;
 * on failure it pushes a human-readable reason onto `errors` and returns `undefined`. RE2 rejects
 * patterns that use features it cannot evaluate in linear time — backreferences (`\1`) and
 * lookaround (`(?=…)`, `(?<=…)`) — so those surface here as compile errors. That rejection is part
 * of the contract, not a bug: it is the price of the linear-time guarantee, and callers should
 * treat "unsupported feature" and "invalid syntax" the same way (the rule does not compile).
 *
 * The returned object is an `RE2`, which extends `RegExp`, so it is drop-in for the `.test()` /
 * `.exec()` surface at existing call sites. For matching many patterns at once, prefer `RE2.Set`
 * (a native multi-pattern scan) over combining sources into one alternation.
 */
export function compileSafeRegex(source: string, where: string, errors: string[]): RegExp | undefined {
	try {
		return new RE2(source);
	} catch (error) {
		errors.push(`${where}: invalid or unsupported regex ${JSON.stringify(source)}: ${(error as Error).message}`);
		return undefined;
	}
}
