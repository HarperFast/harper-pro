ARG NODE_BUILD_VERSION=24
ARG NODE_VERSION=24

FROM docker.io/node:${NODE_BUILD_VERSION} AS build

WORKDIR /usr/src/harper-pro

COPY . .

RUN env NO_USE_GIT=true npm run package

FROM docker.io/node:${NODE_VERSION} AS run

# Install pnpm
RUN <<-EOF
  wget -qO- https://get.pnpm.io/install.sh | ENV="$HOME/.bashrc" SHELL="$(which bash)" bash -
  ln -nsf /home/harper/.local/share/pnpm/pnpm /usr/local/bin/pnpm
EOF

# Change node user to harper
RUN <<-EOF
  mkdir -p /home/harper
  usermod -d /home/harper -l harper node
  groupmod -n harper node
  rm -rf /home/node
  chown -R harper:harper /home/harper
EOF

WORKDIR /home/harper

USER harper

COPY --from=build /usr/src/harper-pro/harperfast-harper-pro-*.tgz .

# Configure NPM
ENV NPM_CONFIG_PREFIX=/home/harper/.npm-global
ENV PATH=/home/harper/.npm-global/bin:$PATH

VOLUME /home/harper/harper

# Install Harper Pro globally
RUN <<-EOF
  npm install --global harperfast-harper-pro-*.tgz
  rm harperfast-harper-pro-*.tgz
  mkdir -p /home/harper/harper
  chown harper:harper /home/harper/harper
EOF

# Harper config parameters
ENV HDB_ADMIN_USERNAME=admin
ENV ROOTPATH=/home/harper/harper
ENV TC_AGREEMENT=yes
ENV NETWORK_OPERATIONSAPI_PORT=9925
ENV LOGGING_STDSTREAMS=true
ENV REPLICATION_HOSTNAME=localhost
ENV DEFAULTS_MODE=prod

EXPOSE 9925
EXPOSE 9926
EXPOSE 9932
EXPOSE 9933

ENTRYPOINT ["harper"]

CMD ["run"]
