ARG NODE_BUILD_VERSION=24
ARG NODE_VERSION=24

FROM docker.io/node:${NODE_BUILD_VERSION} AS build

WORKDIR /usr/src/harper-pro

COPY . .

RUN env NO_USE_GIT=true npm run package

FROM docker.io/node:${NODE_VERSION} AS run

# Change node user to harper
RUN <<-EOF
  mkdir -p /home/harperdb
  usermod -d /home/harperdb -l harperdb node
  groupmod -n harperdb node
  rm -rf /home/node
  chown -R harperdb:harperdb /home/harperdb
  apt-get update
  apt-get install -y --no-install-recommends zstd
  rm -rf /var/lib/apt/lists/*
EOF

WORKDIR /home/harperdb

USER harperdb

# Install pnpm
RUN wget -qO- https://get.pnpm.io/install.sh | ENV="$HOME/.bashrc" SHELL="$(which bash)" bash -

COPY --from=build /usr/src/harper-pro/harperfast-harper-pro-*.tgz .

# Configure NPM
ENV NPM_CONFIG_PREFIX=/home/harperdb/.npm-global
ENV PATH=/home/harperdb/.npm-global/bin:$PATH

# Install Harper Pro globally. Without `set -e` a failed install is masked by the
# exit status of the cleanup commands that follow it, and `harper version` asserts
# the installed bin actually resolves and runs.
COPY --from=build /usr/src/harper-pro/build-tools/install-packed-harper-pro.sh /usr/src/harper-pro/build-tools/check-installed-shrinkwrap.mjs /usr/local/share/harper-pro-install/
RUN <<-EOF
  set -e
  bash /usr/local/share/harper-pro-install/install-packed-harper-pro.sh harperfast-harper-pro-*.tgz
  harper version
  rm harperfast-harper-pro-*.tgz
  mkdir -p /home/harperdb/harper
  chown harperdb:harperdb /home/harperdb/harper
EOF

VOLUME /home/harperdb/harper

# Harper config parameters
ENV HDB_ADMIN_USERNAME=admin
ENV HDB_ADMIN_PASSWORD=password
ENV ROOTPATH=/home/harperdb/harper
ENV TC_AGREEMENT=yes
ENV OPERATIONSAPI_NETWORK_PORT=9925
ENV LOGGING_STDSTREAMS=true
ENV NODE_HOSTNAME=localhost
ENV DEFAULTS_MODE=prod

EXPOSE 9925
EXPOSE 9926
EXPOSE 9932
EXPOSE 9933

ENTRYPOINT ["harper"]

CMD ["run"]
