# Ephemeral, repo-scoped self-hosted GitHub Actions runner for the YCSB cluster
# benchmark. Runs as a non-root user (the Actions runner refuses to run as root).
# The registration token is supplied at runtime (never baked in); the host loop
# (run-bench-runner.sh) mints a fresh token and starts one container per job.
FROM ubuntu:24.04

ARG RUNNER_VERSION=2.334.0
ENV DEBIAN_FRONTEND=noninteractive

# Toolchain for harper-pro's native deps (rocksdb-js / lmdb prebuilds + gyp fallback) + node 24.
# (apt lists are kept for installdependencies.sh below, then cleaned in that layer.)
RUN apt-get update && apt-get install -y --no-install-recommends \
		ca-certificates curl git jq build-essential python3 sudo \
	&& curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
	&& apt-get install -y --no-install-recommends nodejs

RUN useradd -m -s /bin/bash runner
WORKDIR /home/runner

# Download the Actions runner AND install its .NET runtime dependencies
# (libicu, libssl, libkrb5, liblttng-ust, zlib) via the bundled script — run as
# root, then hand the dir to the runner user.
RUN curl -fsSL -o runner.tar.gz \
		"https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
	&& tar xzf runner.tar.gz \
	&& rm runner.tar.gz \
	&& ./bin/installdependencies.sh \
	&& rm -rf /var/lib/apt/lists/* \
	&& chown -R runner:runner /home/runner

COPY --chown=runner:runner entrypoint.sh /home/runner/entrypoint.sh
USER runner
ENTRYPOINT ["/home/runner/entrypoint.sh"]
