FROM caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d
COPY Caddyfile /etc/caddy/Caddyfile
COPY web-entrypoint.sh /usr/local/bin/bungee-web
RUN chmod 0755 /usr/local/bin/bungee-web
ENTRYPOINT ["/usr/local/bin/bungee-web"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
