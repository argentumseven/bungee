#!/usr/bin/env python3
"""Export public endpoint observations only; never request or write WireGuard keys."""
import ipaddress
import json
import os
from pathlib import Path
import subprocess
import time


def observe(endpoints, handshakes, transfers, previous, now):
    previous = {p['public_key']: p for p in previous.get('peers', [])}
    peers = []
    for key, endpoint in endpoints.items():
        handshake = int(handshakes.get(key, '0'))
        if not 0 < handshake <= now or endpoint == '(none)': continue
        try:
            host, _port = endpoint.rsplit(':', 1)
            ip = str(ipaddress.ip_address(host.strip('[]')))
            rx = int(transfers[key].split()[0])
        except (ValueError, KeyError, IndexError): continue
        old = previous.get(key)
        observed = handshake
        if old and old['ip'] == ip and rx == old['rx']:
            observed = max(handshake, old['observed_at'])
        elif old and rx >= old['rx']:
            observed = now
        peers.append({'public_key': key, 'ip': ip, 'observed_at': observed, 'rx': rx})
    return {'sampled_at': now, 'peers': peers}


def main():
    path = Path('/peers/endpoints.json')
    try: previous = json.loads(path.read_text())
    except (FileNotFoundError, ValueError): previous = {}
    def values(field):
        output = subprocess.check_output(['wg', 'show', 'wg0', field], text=True, timeout=2)
        return dict(line.split('\t', 1) for line in output.splitlines())
    result = observe(values('endpoints'), values('latest-handshakes'), values('transfer'), previous, int(time.time()))
    temporary = path.with_suffix('.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(result, stream)
    os.chown(temporary, 10001, 10001)
    os.replace(temporary, path)


if __name__ == '__main__': main()
