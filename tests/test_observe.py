import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('observe', Path(__file__).resolve().parents[1] / 'deploy/wireguard/observe.py')
observe = importlib.util.module_from_spec(spec); spec.loader.exec_module(observe)

class EndpointTests(unittest.TestCase):
    def sample(self, old, endpoint='81.2.69.142:12345', handshake='100', rx=10, now=200):
        return observe.observe({'peer':endpoint},{'peer':handshake},{'peer':f'{rx}\t20'},old,now)
    def test_first_observation_uses_handshake_not_current_time_and_idle_does_not_become_fresh(self):
        first=self.sample({})
        self.assertEqual(first['peers'][0]['observed_at'],100)
        self.assertEqual(self.sample(first,now=300)['peers'][0]['observed_at'],100)
        fresh=self.sample(first,rx=20,now=300)
        self.assertEqual(fresh['peers'][0]['observed_at'],300)
        self.assertEqual(self.sample(fresh,rx=20,now=400)['peers'][0]['observed_at'],300)
    def test_no_handshake_or_malformed_endpoint_is_not_evidence(self):
        for values in [{'handshake':'0'}, {'handshake':'500'}, {'endpoint':'(none)'},{'endpoint':'untrusted.example:53'}]:
            self.assertEqual(self.sample({},**values)['peers'],[])
    def test_ipv6_roaming_and_interface_restart_do_not_invent_an_idle_timestamp(self):
        first=self.sample({})
        roam=self.sample(first,endpoint='[2606:4700:4700::1111]:12345',rx=20,now=300)
        self.assertEqual(roam['peers'][0]['ip'],'2606:4700:4700::1111')
        self.assertEqual(roam['peers'][0]['observed_at'],300)
        restarted=self.sample(roam,endpoint='[2606:4700:4700::1111]:12345',rx=1,handshake='310',now=400)
        self.assertEqual(restarted['peers'][0]['observed_at'],310)
