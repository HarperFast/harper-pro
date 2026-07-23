# Builds a Node.js image identical to docker.io/node:<NODE_VERSION> except:
#  - the node binary is compiled with V8 pointer compression
#    (--experimental-enable-pointer-compression): ~40% lower JS heap memory,
#    4 GB heap cap per isolate (per worker thread — Node uses per-isolate cages)
#  - /usr/local/share/uws-pointer-compression/ carries a uWebSockets.js addon
#    rebuilt against the pointer-compression V8 ABI (the upstream prebuilds
#    link the raw V8 ABI and segfault on a pointer-compression node); the main
#    Dockerfile swaps it into the installed package when present
#
# Node-API addons (rocksdb-js, lmdb, msgpackr/cbor-extract, argon2, ...) are
# unaffected — Node-API is ABI-stable across this flag. Only raw-V8-ABI addons
# (uWS) need the rebuild.
#
# Published as harperfast/node-pointer-compression:<major> by the
# publish-node-pc-image workflow (dispatch-only; re-run when NODE_VERSION or
# the pinned uWS version bumps), and consumed by the main Dockerfile via the
# RUN_IMAGE build arg.

ARG NODE_VERSION=24

FROM docker.io/node:${NODE_VERSION} AS build

WORKDIR /usr/src

# Build the exact Node version shipped in the base image so the binary swap in
# the final stage is version-consistent (npm, headers, docs all match).
RUN <<-EOF
	set -e
	version="$(node -p 'process.version')"
	curl -fsSL "https://nodejs.org/dist/${version}/node-${version}.tar.xz" -o node.tar.xz
	mkdir node-src
	tar -xJf node.tar.xz -C node-src --strip-components=1
	rm node.tar.xz
EOF

WORKDIR /usr/src/node-src

# Default (per-isolate) cage: each worker thread gets its own 4 GB heap rather
# than all isolates sharing one cage.
RUN ./configure --experimental-enable-pointer-compression && make -j"$(nproc)"

RUN out/Release/node -e 'if (process.config.variables.v8_enable_pointer_compression !== 1) { throw new Error("pointer compression not enabled"); }'

# Rebuild uWebSockets.js against the pointer-compression ABI, following the
# linux path of its build.c but only for this image's Node target and with the
# V8 pointer-compression defines (matching the node build above: compressed
# pointers, per-isolate cages, 31-bit smis, external code space).
FROM docker.io/node:${NODE_VERSION} AS uws

# Keep in sync with the uWebSockets.js pin in package.json devDependencies:
# UWS_SOURCE_COMMIT is the `source_commit` file inside the pinned binaries tarball.
ARG UWS_SOURCE_COMMIT=fbdac03ee398031f304ddeb6764358d2eaa6fe29

RUN apt-get update && apt-get install -y --no-install-recommends cmake golang-go && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src
RUN git clone https://github.com/uNetworking/uWebSockets.js.git uws \
	&& cd uws && git checkout ${UWS_SOURCE_COMMIT} && git submodule update --init --recursive

WORKDIR /usr/src/uws

RUN <<-EOF
	set -e
	arch="$(node -p 'process.arch')"
	abi="$(node -p 'process.versions.modules')"
	node_target="v$(node -p 'process.versions.node.split(".")[0]').0.0"
	pc_defines="-DV8_COMPRESS_POINTERS -DV8_COMPRESS_POINTERS_IN_MULTIPLE_CAGES -DV8_31BIT_SMIS_ON_64BIT_ARCH -DV8_EXTERNAL_CODE_SPACE"

	(cd uWebSockets/uSockets/boringssl && mkdir -p build && cd build && cmake -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DCMAKE_BUILD_TYPE=Release .. && make -j"$(nproc)" crypto ssl)
	(cd uWebSockets/uSockets/lsquic && mkdir -p build && cd build && cmake -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DBORINGSSL_DIR=../boringssl -DCMAKE_BUILD_TYPE=Release -DLSQUIC_BIN=Off .. && make -j"$(nproc)" lsquic)

	mkdir -p dist targets
	curl -fsOJ "https://nodejs.org/dist/${node_target}/node-${node_target}-headers.tar.gz"
	tar xzf "node-${node_target}-headers.tar.gz" -C targets
	# v8-fast-api-calls.h is missing from the header distribution (same fetch as build.c)
	curl -fsL "https://raw.githubusercontent.com/nodejs/node/${node_target}/deps/v8/include/v8-fast-api-calls.h" > "targets/node-${node_target}/include/node/v8-fast-api-calls.h"

	gcc -DWIN32_LEAN_AND_MEAN -DLIBUS_USE_LIBUV -DLIBUS_USE_QUIC -I uWebSockets/uSockets/lsquic/include -I uWebSockets/uSockets/boringssl/include -pthread -DLIBUS_USE_OPENSSL -flto -O3 -c -fPIC -I uWebSockets/uSockets/src uWebSockets/uSockets/src/*.c uWebSockets/uSockets/src/eventing/*.c uWebSockets/uSockets/src/crypto/*.c -I "targets/node-${node_target}/include/node"
	g++ ${pc_defines} -DWIN32_LEAN_AND_MEAN -DUWS_WITH_PROXY -DUWS_REMOTE_ADDRESS_USERSPACE -DLIBUS_USE_LIBUV -DLIBUS_USE_QUIC -I uWebSockets/uSockets/boringssl/include -pthread -DLIBUS_USE_OPENSSL -flto -O3 -c -fPIC -std=c++20 -I uWebSockets/uSockets/src -I uWebSockets/src src/addon.cpp uWebSockets/uSockets/src/crypto/sni_tree.cpp -I "targets/node-${node_target}/include/node"
	g++ -pthread -flto -O3 *.o uWebSockets/uSockets/boringssl/build/libssl.a uWebSockets/uSockets/boringssl/build/libcrypto.a uWebSockets/uSockets/lsquic/build/src/liblsquic/liblsquic.a -std=c++20 -shared -static-libstdc++ -static-libgcc -s -o "dist/uws_linux_${arch}_${abi}.node"
EOF

# Rebuild @datadog/pprof against the pointer-compression ABI. Its npm package
# ships prebuilds only (no C++ sources, install script is `exit 0`), so build
# from the GitHub repo at the pinned version. Running node-gyp under the
# pointer-compression node is sufficient: node-gyp generates config.gypi from
# the running node's process.config, which carries v8_enable_pointer_compression
# and yields the matching V8 defines.
FROM docker.io/node:${NODE_VERSION} AS pprof

# Keep in sync with the @datadog/pprof version in package-lock.json.
ARG PPROF_VERSION=5.15.1

COPY --from=build /usr/src/node-src/out/Release/node /usr/local/bin/node

WORKDIR /usr/src
RUN <<-EOF
	set -e
	git clone --depth 1 -b "v${PPROF_VERSION}" https://github.com/DataDog/pprof-nodejs.git pprof
	cd pprof
	npm install --ignore-scripts --no-audit --no-fund
	npx node-gyp rebuild --jobs=max
EOF

FROM docker.io/node:${NODE_VERSION}

COPY --from=build /usr/src/node-src/out/Release/node /usr/local/bin/node
COPY --from=uws /usr/src/uws/dist/*.node /usr/local/share/uws-pointer-compression/
COPY --from=pprof /usr/src/pprof/build/Release/dd_pprof.node /usr/local/share/pprof-pointer-compression/dd_pprof.node

RUN node -e 'if (process.config.variables.v8_enable_pointer_compression !== 1) { throw new Error("pointer compression not enabled"); }'
