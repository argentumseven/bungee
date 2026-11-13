import importlib.util
from pathlib import Path
import socket
import struct
import unittest

spec=importlib.util.spec_from_file_location('route_trace',Path(__file__).resolve().parents[1]/'scripts/trace-update-route.py')
trace=importlib.util.module_from_spec(spec);spec.loader.exec_module(trace)


def packet(payload,src='10.77.0.2',dst='10.77.0.1',sport=45001,dport=8081):
    ip=bytearray(20);ip[0]=0x45;ip[9]=6;ip[12:16]=socket.inet_aton(src);ip[16:20]=socket.inet_aton(dst)
    struct.pack_into('!H',ip,2,40+len(payload))
    tcp=bytearray(20);struct.pack_into('!HH',tcp,0,sport,dport);tcp[12]=0x50
    return bytes(ip+tcp)+payload


class RouteTraceTests(unittest.TestCase):
    def test_only_the_fixed_request_line_is_exposed(self):
        body=b'POST /v1/app-update HTTP/1.1\r\nX-Bungee-Signature: PRIVATE_SIGNATURE\r\n\r\n{"latitude":1,"key":"PRIVATE_KEY"}'
        result=trace.describe(packet(body))
        self.assertEqual(result,'10.77.0.2:45001 -> 10.77.0.1:8081  POST /v1/app-update')
        self.assertNotIn('PRIVATE',result);self.assertNotIn('latitude',result)

    def test_status_excludes_reason_headers_and_body(self):
        result=trace.describe(packet(b'HTTP/1.1 404 PRIVATE_REASON\r\nCookie: PRIVATE_COOKIE\r\n\r\nPRIVATE_BODY',src='10.77.0.1',dst='10.77.0.2',sport=8081,dport=45001))
        self.assertEqual(result,'10.77.0.1:8081 -> 10.77.0.2:45001  HTTP/1.1 404')

    def test_headers_body_fragments_other_ports_and_other_networks_are_not_output(self):
        for payload in [b'X-Bungee-Signature: PRIVATE\r\n',b'{"key":"PRIVATE"}\r\n',b'POST /v1/app-update?token=PRIVATE HTTP/1.1\r\n',b'POST /v1/app-update HTTP/1.1']:
            self.assertIsNone(trace.describe(packet(payload)))
        message=b'POST /v1/sync HTTP/1.1\r\n'
        self.assertIsNone(trace.describe(packet(message,dport=8443)))
        self.assertIsNone(trace.describe(packet(message,dst='192.168.1.1')))
        fragmented=bytearray(packet(message));struct.pack_into('!H',fragmented,6,1)
        self.assertIsNone(trace.describe(fragmented))

    def test_removal_of_old_routes_is_visible_without_their_contents(self):
        self.assertTrue(trace.describe(packet(b'POST /v1/private-dns HTTP/1.1\r\nSECRET')).endswith('POST /v1/private-dns'))
        self.assertTrue(trace.describe(packet(b'POST /v1/app-update/chunk HTTP/1.1\r\nSECRET')).endswith('POST /v1/app-update/chunk'))
        for size in range(40):self.assertIsNone(trace.describe(b'\x45'*size))
