const githubMetaFixtureURL = process.env.HARPER_SSH_KEY_GITHUB_META_FIXTURE_URL;

if (!githubMetaFixtureURL) throw new Error('HARPER_SSH_KEY_GITHUB_META_FIXTURE_URL is required');

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
	const requestURL = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
	return originalFetch(requestURL === 'https://api.github.com/meta' ? githubMetaFixtureURL : input, init);
};
