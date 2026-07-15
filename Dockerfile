# Debian trixie (glibc 2.41) is required at runtime: uWebSockets.js v20.68.0's
# prebuilt Linux binaries link against GLIBC_2.38, which bookworm (glibc 2.36)
# does not provide — the addon fails to load on bookworm even though it ships in
# the image. glibc is forward-compatible, so every other native dep (built
# against <=2.36) keeps loading on trixie. Build and run stages are kept in lock-
# step so from-source addons compiled in the build stage match the run glibc.
ARG NODE_BUILD_VERSION=24-trixie
ARG NODE_VERSION=24-trixie
# Runtime base image. Override with harperfast/node-pointer-compression:<ver>
# to produce the pointer-compression image variant (harper#919): the standard
# node image with the node binary rebuilt with V8 pointer compression (plus a
# matching uWebSockets.js addon, swapped in below).
ARG RUN_IMAGE=docker.io/node:${NODE_VERSION}

FROM docker.io/node:${NODE_BUILD_VERSION} AS build

WORKDIR /usr/src/harper-pro

COPY . .

RUN env NO_USE_GIT=true npm run package

FROM ${RUN_IMAGE} AS run

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

# Install Harper Pro globally
RUN <<-EOF
  npm install --global harperfast-harper-pro-*.tgz
  rm harperfast-harper-pro-*.tgz
  mkdir -p /home/harperdb/harper
  chown harperdb:harperdb /home/harperdb/harper
EOF

# On a pointer-compression base (RUN_IMAGE=harperfast/node-pointer-compression),
# make the native-module tree safe for the pointer-compression V8 ABI — raw-V8-ABI
# prebuilds (uWS, @datadog/pprof) load cleanly but segfault on first use there:
#  - swap in the uWS and pprof binaries rebuilt for that ABI (carried by the
#    base image); the marker files tell the runtime guards they are safe to load
#  - drop version-specific direct-V8 addon variants (node.abi*.node) so their
#    Node-API builds load instead
#  - fail the build if any raw-V8-ABI binary that could load here remains
# No-op on the standard base (the artifacts directory doesn't exist there).
COPY --from=build /usr/src/harper-pro/build-tools/check-native-abi-pointer-compression.js /usr/local/share/
RUN <<-EOF
  set -e
  uws_pc=/usr/local/share/uws-pointer-compression
  if [ -d "$uws_pc" ]; then
    modules=$NPM_CONFIG_PREFIX/lib/node_modules/@harperfast/harper-pro/node_modules
    test -d "$modules/uWebSockets.js"
    cp "$uws_pc"/*.node "$modules/uWebSockets.js/"
    touch "$modules/uWebSockets.js/.pointer-compression-build"

    pprof_dir="$modules/@datadog/pprof"
    test -d "$pprof_dir"
    rm -rf "$pprof_dir/prebuilds"
    mkdir -p "$pprof_dir/prebuilds/linux-$(node -p 'process.arch')"
    cp /usr/local/share/pprof-pointer-compression/dd_pprof.node \
      "$pprof_dir/prebuilds/linux-$(node -p 'process.arch')/dd_pprof.node.abi$(node -p 'process.versions.modules').node"
    touch "$pprof_dir/.pointer-compression-build"

    find "$modules" -name 'node.abi*.node' -delete

    node /usr/local/share/check-native-abi-pointer-compression.js "$NPM_CONFIG_PREFIX/lib/node_modules/@harperfast/harper-pro"
  fi
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
