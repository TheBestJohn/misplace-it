# ---- build ----------------------------------------------------------------
FROM rust:1.94-slim-bookworm AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy manifests first and build a dummy binary so the dependency graph lands
# in its own layer. Editing application source then rebuilds in seconds instead
# of recompiling every crate.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
 && cargo build --release \
 && rm -rf src

COPY src ./src
COPY migrations ./migrations

# Touch main.rs so cargo does not reuse the dummy binary's fingerprint.
RUN touch src/main.rs && cargo build --release

# ---- runtime --------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --create-home app

COPY --from=builder /build/target/release/misplace-it /usr/local/bin/misplace-it

USER app
WORKDIR /home/app

ENV BIND_ADDR=0.0.0.0:8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8080/api/v1/health || exit 1

ENTRYPOINT ["/usr/local/bin/misplace-it"]
