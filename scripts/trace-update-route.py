#!/usr/bin/env python3
"""Read-only WireGuard HTTP route/status trace. Never prints headers or bodies."""
import argparse
import ipaddress
import os
from pathlib import Path
import re
import socket
import struct
import subprocess
import sys
import time

REQUEST = re.compile(rb'POST (/v1/[a-z/-]{1,80}) HTTP/1\.[01]')
STATUS = re.compile(rb'(HTTP/1\.[01]) ([1-5][0-9]{2})(?: [^\r\n]*)?')


def describe(packet):
    """Packet sockets in SOCK_DGRAM mode return an IPv4 packet without a link header."""
    if len(packet) < 40 or packet[0] >> 4 != 4 or packet[9] != 6:
        return None
    ip_size = (packet[0] & 15) * 4
    size = struct.unpack_from('!H', packet, 2)[0]
    if ip_size < 20 or size < ip_size + 20 or len(packet) < ip_size + 20:
        return None
    if struct.unpack_from('!H', packet, 6)[0] & 0x1fff:
        return None
    src = str(ipaddress.IPv4Address(packet[12:16]))
    dst = str(ipaddress.IPv4Address(packet[16:20]))
    if not ((src == '10.77.0.1' and dst.startswith('10.77.0.')) or
            (dst == '10.77.0.1' and src.startswith('10.77.0.'))):
        return None
    sport, dport = struct.unpack_from('!HH', packet, ip_size)
    if 8081 not in (sport, dport):
        return None
    tcp_size = (packet[ip_size + 12] >> 4) * 4
    if tcp_size < 20 or ip_size + tcp_size >= min(size, len(packet)):
        return None
    payload = packet[ip_size + tcp_size:min(size, len(packet))]
    # Inspect only a complete first line. Do not retain or print the remainder.
    line, separator, _ = payload.partition(b'\r\n')
    if not separator or len(line) > 128:
        return None
    request = REQUEST.fullmatch(line)
    status = STATUS.fullmatch(line)
    if request and dport == 8081:
        message = 'POST ' + request[1].decode('ascii')
    elif status and sport == 8081:
        message = status[1].decode('ascii') + ' ' + status[2].decode('ascii')
    else:
        return None
    return f'{src}:{sport} -> {dst}:{dport}  {message}'


def capture(seconds):
    if not hasattr(socket, 'AF_PACKET'):
        raise SystemExit('This diagnostic requires Linux.')
    started = time.monotonic()
    count = 0
    print('Tap Check for updates on the phone now. Listening for', seconds, 'seconds.', flush=True)
    print('Only private flow addresses, request paths and HTTP statuses are printed.', flush=True)
    with socket.socket(socket.AF_PACKET, socket.SOCK_DGRAM, socket.htons(0x0800)) as listener:
        listener.bind(('wg0', 0))
        listener.settimeout(1)
        try:
            while time.monotonic() - started < seconds:
                try:
                    packet = listener.recv(4096)
                except socket.timeout:
                    continue
                message = describe(packet)
                if message is not None:
                    count += 1
                    print(f'+{time.monotonic()-started:.2f}s  {message}', flush=True)
        except KeyboardInterrupt:
            pass
    print('Trace complete:', count, 'HTTP first lines observed.', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gateway', default='bungee-gateway-1')
    parser.add_argument('--seconds', type=int, default=45)
    parser.add_argument('--capture', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not 5 <= args.seconds <= 120:
        parser.error('--seconds must be 5–120')
    if os.geteuid() != 0:
        raise SystemExit('Run this read-only diagnostic as root on the Linux Bungee host.')
    if args.capture:
        capture(args.seconds)
        return
    result = subprocess.check_output(['docker', 'inspect', '--format', '{{.State.Pid}}', args.gateway], stderr=subprocess.PIPE, text=True).strip()
    if not result.isdecimal() or int(result) < 1:
        raise SystemExit('The selected gateway is not running.')
    # Enter only its network namespace; do not change files, routes, peers or services.
    os.execvp('nsenter', ['nsenter', '--target', result, '--net', '--', sys.executable,
                         str(Path(__file__).resolve()), '--capture', '--seconds', str(args.seconds)])


if __name__ == '__main__':
    try:
        main()
    except (OSError, subprocess.SubprocessError):
        raise SystemExit('Could not inspect the running gateway. Check its container name and root access; no configuration was changed.')
