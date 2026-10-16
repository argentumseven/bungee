FROM debian:bookworm-slim
RUN apt-get update && apt-get install --yes --no-install-recommends wireguard-tools iproute2 iptables python3 && rm -rf /var/lib/apt/lists/*
COPY network_config.py /usr/local/lib/bungee/network_config.py
COPY wireguard/entrypoint.sh /usr/local/bin/gateway
RUN chmod 0755 /usr/local/bin/gateway
ENTRYPOINT ["/usr/local/bin/gateway"]
