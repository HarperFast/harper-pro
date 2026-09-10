const githubMetaFixtureURL = process.env.HARPER_SSH_KEY_GITHUB_META_FIXTURE_URL;

if (!githubMetaFixtureURL) throw new Error('HARPER_SSH_KEY_GITHUB_META_FIXTURE_URL is required');

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
	const requestURL = input instanceof Request ? input.url : String(input);
	if (requestURL === 'https://api.github.com/meta') {
		const fixtureRequest = input instanceof Request ? new Request(githubMetaFixtureURL, input) : githubMetaFixtureURL;
		return originalFetch(fixtureRequest, init);
	}
	if (URL.canParse(requestURL) && new URL(requestURL).hostname === 'api.github.com') {
		return Promise.reject(new Error(`Unexpected GitHub API request in SSH key integration test: ${requestURL}`));
	}
	return originalFetch(input, init);
};
