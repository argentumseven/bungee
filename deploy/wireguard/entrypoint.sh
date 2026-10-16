#!/bin/sh
set -eu
umask 077
: "${BUNGEE_WG_PORT:?Choose a custom UDP port}"
case "$BUNGEE_WG_PORT" in ''|*[!0-9]*) echo "Invalid UDP port" >&2; exit 1;; esac
if [ "$BUNGEE_WG_PORT" -lt 1 ] || [ "$BUNGEE_WG_PORT" -gt 65535 ] || [ "$BUNGEE_WG_PORT" -eq 51820 ]; then
    echo "Choose a custom UDP port other than 51820" >&2; exit 1
fi
# One network namespace for gateway, Rust and Caddy. No newly initiated external
# connections: no provider DNS, public CA, analytics, updates or location services.
# Replies to inbound phone/dashboard connections remain permitted.
for firewall in iptables ip6tables; do
    "$firewall" -P INPUT DROP
    "$firewall" -P FORWARD DROP
    "$firewall" -P OUTPUT DROP
    "$firewall" -F
    if [ "$firewall" = iptables ]; then
        "$firewall" -A OUTPUT -d 127.0.0.11 -j DROP
    fi
    "$firewall" -A INPUT -i lo -j ACCEPT
    "$firewall" -A OUTPUT -o lo -j ACCEPT
    "$firewall" -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    "$firewall" -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    "$firewall" -A INPUT -p udp --dport "$BUNGEE_WG_PORT" -j ACCEPT
    "$firewall" -A INPUT -p tcp --dport 443 -j ACCEPT
    "$firewall" -A INPUT -i wg0 -p tcp --dport 8081 -j ACCEPT
    # Essential IPv6 neighbor discovery / path-MTU, not application egress.
    if [ "$firewall" = ip6tables ]; then
        for icmp_type in 1 2 3 4 133 134 135 136; do
            "$firewall" -A INPUT -p ipv6-icmp --icmpv6-type "$icmp_type" -j ACCEPT
            "$firewall" -A OUTPUT -p ipv6-icmp --icmpv6-type "$icmp_type" -j ACCEPT
        done
    fi
done
mkdir -p /private /peers
chmod 0700 /private /peers
chown 10001:10001 /peers
if [ ! -s /private/server-key ]; then wg genkey > /private/server-key; fi
wg pubkey < /private/server-key > /peers/server-public-key
chown 10001:10001 /peers/server-public-key
ip link add wg0 type wireguard
ip address add 10.77.0.1/24 dev wg0
ip link set wg0 mtu 1280 up
trap 'ip link delete wg0 2>/dev/null || true' EXIT INT TERM
while :; do
    {
        printf '[Interface]\nListenPort = %s\nPrivateKey = ' "$BUNGEE_WG_PORT"
        cat /private/server-key
        printf '\n'
        # A persisted pre-upgrade peer file must not open a temporary PSK-free tunnel.
        # Keep the interface empty until Rust replaces legacy configuration after migration.
        if [ -f /peers/peers.conf ] && awk '
            /^\[Peer\]$/ { if (peer && count != 1) exit 1; peer=1; count=0 }
            $1 == "PresharedKey" {
                if (!peer || $2 != "=" || length($3) != 44 || $3 !~ /^[A-Za-z0-9+\/]+=$/ || $3 == "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=") exit 1
                count++
            }
            END { if (peer && count != 1) exit 1 }
        ' /peers/peers.conf; then
            # Data only: this file is never sourced, evaluated, or passed to a shell.
            cat /peers/peers.conf
        fi
    } > /run/wg0.conf
    wg syncconf wg0 /run/wg0.conf
    sleep 3 & wait $!
done
