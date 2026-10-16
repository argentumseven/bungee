FROM node:24-bookworm-slim AS web
WORKDIR /build/web
COPY web/package*.json ./
RUN --mount=type=secret,id=build_ca if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM rust:1.90-slim-bookworm AS server
RUN apt-get update && apt-get install --yes --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY server/Cargo.toml server/Cargo.lock ./server/
COPY release.json ./
COPY server/src ./server/src
RUN --mount=type=secret,id=build_ca if [ -s /run/secrets/build_ca ]; then export CARGO_HTTP_CAINFO=/run/secrets/build_ca; fi; cargo build --release --locked --manifest-path server/Cargo.toml -j 4

FROM debian:bookworm-slim
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 bungee && useradd --uid 10001 --gid 10001 --no-create-home bungee \
    && mkdir -p /state && chown bungee:bungee /state
COPY --from=server /build/server/target/release/bungee-server /usr/local/bin/bungee-server
COPY --from=web /build/web/dist /app/web
USER 10001:10001
WORKDIR /app
ENV BUNGEE_STATE_DIR=/state BUNGEE_WEB_DIR=/app/web
EXPOSE 8080 8081
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD curl --fail --silent http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/bungee-server"]
