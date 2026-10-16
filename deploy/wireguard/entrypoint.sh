#!/bin/sh
set -eu
umask 077
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
        printf '[Interface]\nListenPort = 51820\nPrivateKey = '
        cat /private/server-key
        printf '\n'
        if [ -f /peers/peers.conf ]; then
            # Data only: this file is never sourced, evaluated, or passed to a shell.
            cat /peers/peers.conf
        fi
    } > /run/wg0.conf
    wg syncconf wg0 /run/wg0.conf
    sleep 3 & wait $!
done
