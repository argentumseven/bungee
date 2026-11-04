// Exercise real INPUT hooks and Rust's interface-bound listener without requiring
// kernel WireGuard in CI. A second veth named wg0 models decrypted ingress only.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, chmod, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';

const prefix = `bungee-isolation-${process.pid}`;
const management = `${prefix}-management`, phones = `${prefix}-phones`;
const gateway = `${prefix}-gateway`, phone = `${prefix}-phone`;
const administrator = `${prefix}-admin`, server = `${prefix}-server`;
const dir = await mkdtemp(join(tmpdir(), 'bungee-isolation-'));
const docker = (args, input) => execFileSync('docker', args, {
  input, encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
}).trim();
const address = (name, network) => docker(['inspect', '-f', `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, name]);
const connect = (name, ip, port) => docker(['exec', name, 'node', '-e', `
  const s=require('net').connect({host:process.argv[1],port:Number(process.argv[2])});
  s.once('connect',()=>{console.log('connected');s.destroy();});
  s.once('error',()=>process.exit(3));
  s.setTimeout(1200,()=>process.exit(4));
`, ip, String(port)]);
const denied = (name, ip, port, message) => assert.throws(
  () => connect(name, ip, port), e => e.status === 3 || e.status === 4, message,
);
const firewall = readFileSync('deploy/wireguard/entrypoint.sh', 'utf8').split('mkdir -p /private /peers')[0];
let subnet;
const install = () => docker(['exec', '-i', '-e', 'BUNGEE_WG_PORT=47937',
  '-e', `BUNGEE_ADMIN_SUBNETS=${subnet}`, gateway, 'sh'], firewall);
async function until(check, message) {
  for (let n = 0; n < 80; n++) {
    try { if (check()) return; } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw Error(message);
}
try {
  const verifier = docker(['run','--rm','-i','--network','none','--read-only','--cap-drop','ALL','bungee-server:dev','--hash-admin-password'], 'test-only-container-password-not-a-secret');
  docker(['network', 'create', '--internal', management]);
  // Isolated synthetic addresses, never a production network or phone.
  docker(['network', 'create', '--internal', '--subnet', '10.77.0.0/24', '--gateway', '10.77.0.254', phones]);
  subnet = JSON.parse(docker(['network', 'inspect', management]))[0].IPAM.Config[0].Subnet;
  docker(['run', '-d', '--rm', '--name', gateway, '--network', management,
    '--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN', '--read-only', '--tmpfs', '/run:mode=0700',
    '--entrypoint', 'tail', 'bungee-gateway:dev', '-f', '/dev/null']);
  docker(['network', 'connect', '--ip', '10.77.0.1', phones, gateway]);
  const link = docker(['exec', gateway, 'ip', '-o', '-4', 'addr', 'show']).split('\n')
    .find(line => line.includes('10.77.0.1/24')).trim().split(/\s+/)[1].split('@')[0];
  assert.notEqual(link, 'eth0');
  docker(['exec', gateway, 'ip', 'link', 'set', link, 'down']);
  docker(['exec', gateway, 'ip', 'link', 'set', link, 'name', 'wg0']);
  docker(['exec', gateway, 'ip', 'link', 'set', 'wg0', 'up']);
  docker(['run', '-d', '--rm', '--name', phone, '--network', phones, '--ip', '10.77.0.2',
    '--read-only', '--cap-drop', 'ALL', '--tmpfs', '/run', 'node:24-bookworm-slim', 'tail', '-f', '/dev/null']);
  docker(['run', '-d', '--rm', '--name', administrator, '--network', management,
    '--read-only', '--cap-drop', 'ALL', 'node:24-bookworm-slim', 'tail', '-f', '/dev/null']);
  const managementIp = address(gateway, management);

  // Establish a connection before policy installation. A blanket conntrack
  // ESTABLISHED allow placed ahead of phone classification would preserve it.
  docker(['exec', '-d', gateway, 'python3', '-c', `
import os,socketserver
open('/run/echo.pid','w').write(str(os.getpid()))
class Echo(socketserver.BaseRequestHandler):
 def handle(self):
  while data := self.request.recv(1024): self.request.sendall(data)
socketserver.ThreadingTCPServer.allow_reuse_address=True
socketserver.ThreadingTCPServer(('0.0.0.0',8443),Echo).serve_forever()
`]);
  await until(() => connect(administrator, managementIp, 8443) === 'connected', 'Echo fixture did not start');
  docker(['exec', '-d', phone, 'node', '-e', `
const fs=require('fs'),s=require('net').connect(8443,'10.77.0.1');let count=0,sent=false;
s.on('connect',()=>s.write('before'));
s.on('data',()=>fs.writeFileSync('/run/replies',String(++count)));
s.on('error',()=>{});
setInterval(()=>{if(!sent&&fs.existsSync('/run/send-after')){sent=true;s.write('after');fs.writeFileSync('/run/sent-after','1');}},20);
`]);
  await until(() => docker(['exec', phone, 'cat', '/run/replies']) === '1', 'Pre-policy connection was not established');
  install();
  docker(['exec', phone, 'touch', '/run/send-after']);
  await until(() => docker(['exec', phone, 'cat', '/run/sent-after']) === '1', 'Existing client did not attempt its post-policy send');
  await new Promise(r => setTimeout(r, 1600));
  assert.equal(docker(['exec', phone, 'cat', '/run/replies']), '1', 'Existing management connection must be blocked on wg0');
  assert.equal(connect(administrator, managementIp, 8443), 'connected');
  denied(phone, '10.77.0.1', 8443, 'Phone cannot open administration');
  // Even a permissive rule later in the chain cannot override phone isolation.
  docker(['exec', gateway, 'iptables', '-A', 'INPUT', '-i', 'wg0', '-p', 'tcp', '--dport', '8443', '-j', 'ACCEPT']);
  denied(phone, managementIp, 8443, 'Phone cannot reach the administrator socket using its eth0 destination address');
  docker(['exec', gateway, 'python3', '-c', "import os,signal;os.kill(int(open('/run/echo.pid').read()),signal.SIGTERM)"]);

  execFileSync('python3', ['-c', "import sys;sys.path.insert(0,'scripts');import tls_config;tls_config.ensure(sys.argv[1],'management.internal')", join(dir, 'tls')]);
  const issued = join(dir, 'tls/issued');
  async function readable(path) {
    await chmod(path, 0o755);
    for (const entry of await readdir(path, {withFileTypes: true})) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await readable(child);
      else if (!entry.isSymbolicLink()) await chmod(child, 0o644);
    }
  }
  await readable(issued); // Synthetic keys only, readable by UID 10001 in the image.
  docker(['run', '-d', '--rm', '--name', server, '--network', `container:${gateway}`,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--tmpfs', '/state:uid=10001,gid=10001,mode=0700', '--tmpfs', '/tmp',
    '--mount', `type=bind,src=${issued},dst=/tls,readonly`,
    '-e', 'BUNGEE_PUBLIC_ORIGIN=https://management.internal',
    '-e', 'BUNGEE_ADMIN_BIND=0.0.0.0:8443', '-e', 'BUNGEE_ADMIN_INTERFACE=eth0',
    '-e', `BUNGEE_ADMIN_SUBNETS=${subnet}`, '-e', 'BUNGEE_DEVICE_BIND=10.77.0.1:8081',
    '-e', 'BUNGEE_TLS_CERT_FILE=/tls/current/server.crt', '-e', 'BUNGEE_TLS_KEY_FILE=/tls/current/server.key',
    '--entrypoint', 'sh', 'bungee-server:dev', '-ec', 'printf "%s\\n" "$1" > /state/admin-password.hash; exec /usr/local/bin/bungee-server', 'bootstrap', verifier]);
  await until(() => connect(phone, '10.77.0.1', 8081) === 'connected', 'Rust device API did not start');
  denied(phone, '10.77.0.1', 5353, 'Removed DNS listener is unavailable');
  assert.equal(connect(administrator, managementIp, 8443), 'connected', 'Internal administration remains reachable');
  denied(administrator, managementIp, 8081, 'Device API is not exposed on management eth0');
  denied(phone, '10.77.0.1', 8443, 'Rust administration is unreachable from wg0');
  denied(phone, managementIp, 8443, 'Changing the destination to eth0 does not bypass wg0 isolation');
  // A synthetic TLS-port listener isolates firewall admission from certificate/protocol tests.
  docker(['exec','-d',gateway,'python3','-c',"import socketserver;socketserver.ThreadingTCPServer.allow_reuse_address=True;socketserver.ThreadingTCPServer(('0.0.0.0',8853),socketserver.BaseRequestHandler).serve_forever()"]);
  await until(()=>docker(['exec',gateway,'sh','-c',"ss -ltn | grep ':8853 '"]).includes('8853'),'DoT admission fixture did not start');
  denied(administrator,managementIp,8853,'Public DoT is closed by default');
  denied(phone,'10.77.0.1',8853,'Removed TLS relay is blocked on phone ingress');
  assert.equal(connect(phone, '10.77.0.1', 8081), 'connected');

  // Deliberately relax INPUT in this isolated fixture: the real Rust TLS listener
  // must still reject wg0 by SO_BINDTODEVICE, even with a valid eth0 destination.
  docker(['exec', gateway, 'iptables', '-F', 'INPUT']);
  docker(['exec', gateway, 'iptables', '-P', 'INPUT', 'ACCEPT']);
  assert.equal(connect(administrator, managementIp, 8443), 'connected');
  assert.equal(connect(phone, '10.77.0.1', 8081), 'connected');
  denied(phone, '10.77.0.1', 8443, 'Interface binding independently excludes wg0');
  denied(phone, managementIp, 8443, 'Interface binding survives a destination-address bypass attempt');
  assert.equal(docker(['exec', gateway, 'iptables', '-S', 'FORWARD']), '-P FORWARD DROP');
  console.log('PASS: established and new wg0 administration blocked; C2 retained; removed DNS services blocked; internal HTTPS reachable; real non-root Rust interface binding survives relaxed INPUT. Synthetic veth ingress, not a WireGuard cryptographic test.');
} catch (error) {
  try { console.error(docker(['logs', server])); } catch {}
  throw error;
} finally {
  for (const name of [server, phone, administrator, gateway]) {
    try { docker(['rm', '-f', name]); } catch {}
  }
  for (const name of [phones, management]) {
    try { docker(['network', 'rm', name]); } catch {}
  }
  await rm(dir, {recursive: true, force: true});
}
