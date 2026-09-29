// The peer's share of the long work: it loads the candidate to check it, and this module takes that long to load.
// The export makes the loader compile it as a module, where the top-level await is allowed.
export const loadDelayMs = Number.parseInt(process.env.HARPER_TEST_LOAD_DELAY_MS || '0', 10);
await new Promise((resolve) => setTimeout(resolve, loadDelayMs));
