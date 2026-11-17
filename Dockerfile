# syntax=docker/dockerfile:1.7
#
#   docker build -t pf-fleet .                      # version "<agent/Cargo.toml>-dev"
#   docker build --build-arg VERSION=1.2.3 .        # what CI does for a v1.2.3 tag
#   docker build --target agent-binaries -o out .   # just the agent binaries
#
# The agent and web stages run on the build machine's platform (they cross-compile /
# produce platform-independent output), so a multi-arch build never emulates rustc.

ARG VERSION=""

# ---- agent: static musl binaries for x86_64 and aarch64 ----
FROM --platform=$BUILDPLATFORM rust:1.100.0-alpine3.24 AS agent
ARG VERSION
RUN apk add --no-cache musl-dev zig \
 && cargo install cargo-zigbuild --version 0.24.1 --locked \
 && rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl
WORKDIR /src
COPY protocol ./protocol
COPY agent ./agent
WORKDIR /src/agent
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/agent/target \
    # no VERSION (a local build): "<Cargo version>-dev", which sorts before that release, so a
    # local build never passes for it and the real release still replaces it
    V="${VERSION:-$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)-dev}" \
 && export PF_FLEET_VERSION="$V" \
 && cargo test --release --locked \
 && cargo zigbuild --release --locked --target x86_64-unknown-linux-musl --target aarch64-unknown-linux-musl \
 && mkdir -p /out \
 && cp target/x86_64-unknown-linux-musl/release/pf-fleet-agent /out/pf-fleet-agent-x86_64 \
 && cp target/aarch64-unknown-linux-musl/release/pf-fleet-agent /out/pf-fleet-agent-aarch64 \
 && echo "$V" > /out/VERSION \
 && /out/pf-fleet-agent-x86_64 version | grep -qx "pf-fleet-agent $V"

FROM scratch AS agent-binaries
COPY --from=agent /out /

# ---- web: static build ----
FROM --platform=$BUILDPLATFORM oven/bun:1.4.4-alpine AS web
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile --filter @pf-fleet/web
COPY packages/protocol packages/protocol
COPY apps/web apps/web
RUN cd apps/web && bun run build

# ---- server dependencies (pure JS, so installed once on the build platform) ----
FROM --platform=$BUILDPLATFORM oven/bun:1.4.4-alpine AS deps
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile --production --filter @pf-fleet/server

# ---- runtime ----
FROM oven/bun:1.4.4-alpine
ARG VERSION
WORKDIR /app
# the whole tree: bun links workspace dependencies under each workspace's node_modules
COPY --from=deps /app ./
COPY packages/protocol packages/protocol
COPY apps/server/src apps/server/src
COPY apps/server/drizzle apps/server/drizzle
COPY --from=web /app/apps/web/dist web
COPY --from=agent /out agent-dist
RUN mkdir -p /data && chown bun:bun /data
USER bun
ENV NODE_ENV=production \
    PORT=1337 \
    DATABASE_PATH=/data/fleet.db \
    AGENT_DIR=/app/agent-dist \
    WEB_DIR=web
EXPOSE 1337
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:1337/healthz >/dev/null || exit 1
# the dashboard reports the same version as the agent it ships
CMD ["sh", "-c", "export APP_VERSION=\"${APP_VERSION:-$(cat /app/agent-dist/VERSION)}\"; exec bun apps/server/src/index.ts"]
