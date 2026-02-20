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
EOF

WORKDIR /home/harperdb

USER harperdb

# Install pnpm
RUN wget -qO- https://get.pnpm.io/install.sh | ENV="$HOME/.bashrc" SHELL="$(which bash)" bash -

# Add pnpm to PATH
ENV PATH=/home/harperdb/.local/share/pnpm:$PATH

COPY --from=build /usr/src/harper-pro/harperfast-harper-pro-*.tgz .

# Configure NPM
ENV NPM_CONFIG_PREFIX=/home/harperdb/.npm-global
ENV PATH=/home/harperdb/.npm-global/bin:$PATH

VOLUME /home/harperdb/harper

# Install Harper Pro globally
RUN <<-EOF
  npm install --global harperfast-harper-pro-*.tgz
  rm harperfast-harper-pro-*.tgz
  mkdir -p /home/harperdb/harper
  chown harperdb:harperdb /home/harperdb/harper
EOF

# Harper config parameters
ENV HDB_ADMIN_USERNAME=admin
ENV ROOTPATH=/home/harperdb/harper
ENV TC_AGREEMENT=yes
ENV NETWORK_OPERATIONSAPI_PORT=9925
ENV LOGGING_STDSTREAMS=true
ENV NODE_HOSTNAME=localhost
ENV DEFAULTS_MODE=prod

EXPOSE 9925
EXPOSE 9926
EXPOSE 9932
EXPOSE 9933

ENTRYPOINT ["harper"]

CMD ["run"]
