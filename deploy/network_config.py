#!/usr/bin/env python3
"""Shared, dependency-free input validation for the installer and gateway."""
import ipaddress
import json
import os
import re
import sys

PHONE_NETWORK = ipaddress.ip_network('10.77.0.0/24')


def port(value, wireguard=False):
    text = str(value)
    if not re.fullmatch(r"[0-9]{1,5}", text) or not 1 <= int(text) <= 65535:
        raise ValueError("Ports must be whole numbers from 1 to 65535")
    if wireguard and int(text) == 51820:
        raise ValueError("WireGuard port 51820 is not permitted")
    return int(text)


def admin_networks(value):
    entries = re.split(r"[\s,]+", value.strip()) if isinstance(value, str) else value
    if not isinstance(entries, list) or not 1 <= len(entries) <= 32:
        raise ValueError("Enter 1–32 administrator IP addresses or network prefixes")
    networks = []
    for entry in entries:
        if not isinstance(entry, str) or '%' in entry:
            raise ValueError("Scoped addresses and non-text networks are not supported")
        network = ipaddress.ip_network(entry, strict=False)
        if network.prefixlen < (8 if network.version == 4 else 16):
            raise ValueError("Administrator prefixes must be /8 or narrower for IPv4, /16 or narrower for IPv6; allow-everyone is forbidden")
        if network.is_multicast or network.network_address.is_unspecified or network.network_address.is_multicast:
            raise ValueError("Unspecified and multicast administrator networks are forbidden")
        if network.version == 6 and network.overlaps(ipaddress.ip_network('::ffff:0:0/96')):
            raise ValueError("Enter IPv4 addresses directly, not IPv4-mapped IPv6 prefixes")
        if network.version == 4 and network.overlaps(PHONE_NETWORK):
            raise ValueError("Administrator networks must not overlap the phone C2 subnet 10.77.0.0/24")
        if network not in networks:
            networks.append(network)
    return [str(n) for n in networks]


def address(value, endpoint=False):
    if not isinstance(value, str) or '%' in value:
        raise ValueError("Scoped addresses are not supported")
    ip = ipaddress.ip_address(value)
    if endpoint and (ip.is_unspecified or ip.is_multicast or ip.is_loopback):
        raise ValueError("Use the numeric home-server address reachable by your phones")
    return str(ip)


def management_address(value):
    ip = ipaddress.ip_address(address(value))
    if (ip.is_unspecified or ip.is_multicast or ip.is_link_local or
        (ip.version == 4 and (ip in PHONE_NETWORK or ip.packed[0] == 0 or ip.packed[0] >= 224)) or
        (ip.version == 6 and ip.ipv4_mapped is not None)):
        raise ValueError('Bind HTTPS to one internal management IP or loopback, never a wildcard or phone-overlay address')
    return str(ip)


def hostname(value):
    if not isinstance(value, str): raise ValueError('Dashboard address must be text')
    try:
        ip = ipaddress.ip_address(value.strip('[]'))
        if ip.is_unspecified or ip.is_multicast:
            raise ValueError("Use the dashboard's actual address, not a wildcard")
        return str(ip)
    except ValueError:
        if not re.fullmatch(r"(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?", value):
            raise ValueError("Use an IP address or a locally resolved DNS name, without a scheme, path or port")
        if all(c in '0123456789.' for c in value) or any(not label or len(label) > 63 or label.startswith('-') or label.endswith('-') for label in value.split('.')):
            raise ValueError("Invalid dashboard name")
        return value.lower()


def bracket(ip):
    return f'[{ip}]' if ':' in ip else ip


def dns_upstream(value):
    if not value: return ''
    if not isinstance(value, str) or '%' in value: raise ValueError('DNS upstream must be a literal IP')
    ip = ipaddress.ip_address(value)
    if (ip.is_unspecified or ip.is_multicast or ip.is_link_local or
        (ip.version == 4 and (ip.packed[0] == 0 or ip.packed[0] >= 224 or ip in ipaddress.ip_network('10.77.0.0/24') or str(ip) == '127.0.0.11')) or
        (ip.version == 6 and ip.ipv4_mapped is not None)):
        raise ValueError('Choose a unicast resolver outside the phone subnet and Docker DNS')
    return str(ip)


def validate(config):
    if not isinstance(config, dict) or set(config) - {'geodata', 'dns_upstream_ip', 'dns_upstream_port', 'storage_size_gib', 'map_regions'} != {'wg_port', 'web_port', 'endpoint_ip', 'web_host', 'bind_ip', 'admin_subnets', 'auto_updates', 'channel'}:
        raise ValueError("Configuration has missing or unknown fields")
    result = dict(config)
    if 'map_regions' in config:
        regions=config['map_regions']
        if not isinstance(regions,list) or len(regions)>24 or any(not isinstance(value,str) or not re.fullmatch('[a-z][a-z0-9-]{1,47}',value) for value in regions) or len(set(regions))!=len(regions):
            raise ValueError('Choose up to 24 distinct map region IDs')
    if 'dns_upstream_ip' in config: result['dns_upstream_ip'] = dns_upstream(config['dns_upstream_ip'])
    if 'dns_upstream_port' in config: result['dns_upstream_port'] = port(config['dns_upstream_port'])
    if 'storage_size_gib' in config and (type(config['storage_size_gib']) is not int or not 2 <= config['storage_size_gib'] <= 1048576):
        raise ValueError('Storage size must be 2–1048576 GiB')
    if 'geodata' in config and (not isinstance(config['geodata'], str) or not re.fullmatch(r'[a-f0-9]{24}', config['geodata'])):
        raise ValueError('Invalid local dataset generation')
    result['wg_port'] = port(config['wg_port'], wireguard=True)
    result['web_port'] = port(config['web_port'])
    result['endpoint_ip'] = address(config['endpoint_ip'], endpoint=True)
    result['bind_ip'] = management_address(config['bind_ip'])
    result['web_host'] = hostname(config['web_host'])
    result['admin_subnets'] = admin_networks(config['admin_subnets'])
    if type(config['auto_updates']) is not bool or config['channel'] not in ('stable', 'preview'):
        raise ValueError("Choose stable or preview updates and a boolean auto_updates value")
    return result


def origin(config):
    return 'https://' + bracket(config['web_host']) + (f":{config['web_port']}" if config['web_port'] != 443 else '')


if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['firewall']:
            port(os.environ['BUNGEE_WG_PORT'], wireguard=True)
            management_address(os.environ.get('BUNGEE_ADMIN_ADDRESS', '127.0.0.1'))
            for net in admin_networks(os.environ.get('BUNGEE_ADMIN_SUBNETS', '')):
                print(ipaddress.ip_network(net).version, net)
        elif sys.argv[1:] == ['dns']:
            print(dns_upstream(os.environ.get('BUNGEE_DNS_UPSTREAM_IP', '')))
            port(os.environ.get('BUNGEE_DNS_UPSTREAM_PORT', '53'))
        elif sys.argv[1:] == ['validate']:
            print(json.dumps(validate(json.load(sys.stdin)), indent=2))
        else:
            raise ValueError('Expected firewall or validate')
    except (ValueError, KeyError, TypeError) as exc:
        sys.exit(f'Configuration rejected: {exc}')
