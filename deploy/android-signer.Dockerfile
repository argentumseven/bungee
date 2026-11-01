FROM debian:bookworm-slim
RUN apt-get update && apt-get install --yes --no-install-recommends default-jre-headless apksigner zipalign aapt && rm -rf /var/lib/apt/lists/*
WORKDIR /work
