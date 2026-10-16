#!/bin/sh
set -eu
umask 077
# Parse the entire list before installing any accept rule. Bare addresses become hosts.
admin_rules=$(python3 /usr/local/lib/bungee/network_config.py firewall)
: "${BUNGEE_WG_PORT:?Choose a custom UDP port}"
case "$BUNGEE_WG_PORT" in ''|*[!0-9]*) echo "Invalid UDP port" >&2; exit 1;; esac
if [ "$BUNGEE_WG_PORT" -lt 1 ] || [ "$BUNGEE_WG_PORT" -gt 65535 ] || [ "$BUNGEE_WG_PORT" -eq 51820 ]; then
    echo "Choose a custom UDP port other than 51820" >&2; exit 1
fi
# Optional bounded exception for the operator's own private home DNS upstream.
dns_ip="${BUNGEE_DNS_UPSTREAM_IP:-}"
dns_port="${BUNGEE_DNS_UPSTREAM_PORT:-53}"
dns_firewall=iptables
if [ -n "$dns_ip" ]; then
    case "$dns_port" in ''|*[!0-9]*) echo "Invalid home DNS port" >&2; exit 1;; esac
    if [ "$dns_port" -lt 1 ] || [ "$dns_port" -gt 65535 ]; then echo "Invalid home DNS port" >&2; exit 1; fi
    case "$dns_ip" in
        *:*)
            case "$dns_ip" in *[!0-9A-Fa-f:]*) echo "Invalid DNS IP" >&2; exit 1;; esac
            case "$dns_ip" in [fF][cCdD]*|::1) dns_firewall=ip6tables;; *) echo "DNS requires a private home IP" >&2; exit 1;; esac;;
        *)
            if ! printf '%s\n' "$dns_ip" | awk -F. 'NF!=4 {exit 1} {for(i=1;i<=4;i++) if($i !~ /^[0-9]+$/ || $i>255) exit 1; if($0=="127.0.0.11" || ($1==10&&$2==77&&$3==0)) exit 1; if(!($1==10 || $1==127 || ($1==192&&$2==168) || ($1==172&&$2>=16&&$2<=31))) exit 1}'; then
                echo "DNS requires a numeric private home IP outside the tunnel subnet" >&2; exit 1
            fi;;
    esac
fi
# Shared namespace. Only the selected private home DNS service may receive new
# outbound application connections; no public resolver, CA, analytics or updates.
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
    printf '%s\n' "$admin_rules" | while read -r family subnet; do
        if { [ "$family" = 4 ] && [ "$firewall" = iptables ]; } || { [ "$family" = 6 ] && [ "$firewall" = ip6tables ]; }; then
            "$firewall" -A INPUT -s "$subnet" -p tcp --dport 443 -j ACCEPT
        fi
    done
    "$firewall" -A INPUT -i wg0 -p tcp --dport 8081 -j ACCEPT
    # Essential IPv6 neighbor discovery / path-MTU, not application egress.
    if [ "$firewall" = ip6tables ]; then
        for icmp_type in 1 2 3 4 133 134 135 136; do
            "$firewall" -A INPUT -p ipv6-icmp --icmpv6-type "$icmp_type" -j ACCEPT
            "$firewall" -A OUTPUT -p ipv6-icmp --icmpv6-type "$icmp_type" -j ACCEPT
        done
    fi
done
# Host updater can close admission before snapshots and while checking a candidate.
# The directory is mounted read-only, contains no keys, and cannot be changed by the app.
admission=unknown
refresh_admission() {
    wanted=open
    if [ -n "${BUNGEE_UPDATE_CONTROL:-}" ]; then
        wanted=closed
        if [ "$(cat "$BUNGEE_UPDATE_CONTROL/status" 2>/dev/null || true)" = open ]; then wanted=open; fi
    fi
    [ "$wanted" != "$admission" ] || return 0
    for fw in iptables ip6tables; do
        if [ "$admission" = unknown ]; then
            "$fw" -N BUNGEE_HOLD 2>/dev/null || "$fw" -F BUNGEE_HOLD
            "$fw" -A BUNGEE_HOLD -p udp --dport "$BUNGEE_WG_PORT" -j DROP
            "$fw" -A BUNGEE_HOLD -p tcp --dport 443 -j DROP
            "$fw" -A BUNGEE_HOLD -i wg0 -p tcp --dport 8081 -j DROP
            "$fw" -I INPUT 1 -j BUNGEE_HOLD
        fi
        if [ "$wanted" = open ]; then
            "$fw" -D INPUT -j BUNGEE_HOLD
        elif [ "$admission" = open ]; then
            "$fw" -I INPUT 1 -j BUNGEE_HOLD
        fi
    done
    admission=$wanted
    printf '%s\n' "$wanted" > /run/bungee-admission
}
refresh_admission
iptables -t nat -F PREROUTING
if [ -n "$dns_ip" ]; then
    for protocol in udp tcp; do
        "$dns_firewall" -A OUTPUT -d "$dns_ip" -p "$protocol" --dport "$dns_port" -j ACCEPT
        iptables -t nat -A PREROUTING -i wg0 -p "$protocol" --dport 53 -j REDIRECT --to-ports 5353
        iptables -A INPUT -i wg0 -p "$protocol" --dport 5353 -j ACCEPT
    done
fi
mkdir -p /private /peers
# A previous run leaves /peers owned by Rust. CHOWN permits reclaiming it;
# DAC_OVERRIDE alone does not permit chmod of another UID's directory.
chown 0:0 /private /peers
chmod 0700 /private /peers
chown 10001:10001 /peers
if [ ! -s /private/server-key ]; then wg genkey > /private/server-key; fi
wg pubkey < /private/server-key > /peers/server-public-key
chown 10001:10001 /peers/server-public-key
ip link add wg0 type wireguard
ip address add 10.77.0.1/24 dev wg0
ip link set wg0 mtu 1280 up
trap 'ip link delete wg0 2>/dev/null || true' EXIT
trap 'exit 0' INT TERM
while :; do
    refresh_admission
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
