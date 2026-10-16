FROM debian:bookworm-slim
RUN apt-get update && apt-get install --yes --no-install-recommends wireguard-tools iproute2 iptables && rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /usr/local/bin/gateway
RUN chmod 0755 /usr/local/bin/gateway
ENTRYPOINT ["/usr/local/bin/gateway"]
