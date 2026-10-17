// Isolated Docker-only checks. No provider endpoint or household data is used.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const prefix = `bungee-network-test-${process.pid}`;
const gateway = `${prefix}-gateway`,
  upstream = `${prefix}-upstream`;
const image =
  "node:24-bookworm-slim";
const docker = (args, input) =>
  execFileSync("docker", args, {
    input,
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  }).trim();
const probe = (ip) =>
  docker([
    "exec",
    gateway,
    "timeout",
    "2",
    "bash",
    "-c",
    'exec 3<>/dev/tcp/"$1"/8088; printf "GET / HTTP/1.0\\r\\n\\r\\n" >&3; head -1 <&3',
    "probe",
    ip,
  ]);
const udpProbe = (ip, port=8088) => docker(['exec',gateway,'python3','-c',"import socket,sys;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(1);s.sendto(b'fixture',(sys.argv[1],int(sys.argv[2])));assert s.recv(512)==b'fixture';print('udp-ok')",ip,String(port)]);
try {
  docker(["network", "create", prefix]);
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    upstream,
    "--network",
    prefix,
    image,
    "node", "-e", "require('http').createServer((q,s)=>s.end('fixture')).listen(8088);const u=require('dgram').createSocket('udp4');u.on('message',(b,p)=>u.send(b,p.port,p.address));u.bind(8088);",
  ]);
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    gateway,
    "--network",
    prefix,
    "-p",
    "127.0.0.1::8443",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "NET_ADMIN",
    "--read-only",
    "--tmpfs",
    "/run:mode=0700",
    "--entrypoint",
    "tail",
    "bungee-gateway:dev",
    "-f",
    "/dev/null",
  ]);
  const upstreamIp = docker([
    "inspect",
    "-f",
    `{{(index .NetworkSettings.Networks "${prefix}").IPAddress}}`,
    upstream,
  ]);
  assert.match(upstreamIp, /^\d+\.\d+\.\d+\.\d+$/);
  assert.match(probe(upstreamIp), /200 OK/);
  assert.equal(udpProbe(upstreamIp),'udp-ok');
  const firewall = readFileSync("deploy/wireguard/entrypoint.sh", "utf8").split(
    "mkdir -p /private /peers",
  )[0];
  docker(["exec", "-i", "-e", "BUNGEE_WG_PORT=47937", "-e", "BUNGEE_ADMIN_SUBNETS=127.0.0.1/32 172.16.0.0/12 192.168.0.0/16", gateway, "sh"], firewall);
  assert.throws(
    () => probe(upstreamIp),
    (e) => e.status === 124,
    "new outbound TCP is dropped after firewall setup",
  );
  assert.throws(
    () =>
      docker([
        "exec",
        gateway,
        "timeout",
        "2",
        "bash",
        "-c",
        "exec 3<>/dev/tcp/127.0.0.11/53",
      ]),
    (e) => e.status === 124,
    "Docker provider DNS is dropped",
  );
  assert.throws(()=>udpProbe(upstreamIp), 'new outbound UDP is dropped');
  // Enable exactly one operator-selected resolver destination/port. No fallback.
  docker(
    [
      "exec",
      "-i",
      "-e",
      "BUNGEE_WG_PORT=47937",
      "-e",
      "BUNGEE_ADMIN_SUBNETS=127.0.0.1/32 172.16.0.0/12 192.168.0.0/16",
      "-e",
      `BUNGEE_DNS_UPSTREAM_IP=${upstreamIp}`,
      "-e",
      "BUNGEE_DNS_UPSTREAM_PORT=8088",
      gateway,
      "sh",
    ],
    firewall,
  );
  assert.match(probe(upstreamIp), /200 OK/);
  assert.equal(udpProbe(upstreamIp),'udp-ok');
  assert.throws(()=>udpProbe(upstreamIp,8089), 'another UDP resolver port stays blocked');
  assert.throws(
    () =>
      docker([
        "exec",
        gateway,
        "timeout",
        "2",
        "bash",
        "-c",
        'exec 3<>/dev/tcp/"$1"/8089',
        "probe",
        upstreamIp,
      ]),
    (e) => e.status === 124,
    "another upstream port remains blocked",
  );
  assert.throws(
    () =>
      docker([
        "exec",
        gateway,
        "timeout",
        "2",
        "bash",
        "-c",
        "exec 3<>/dev/tcp/127.0.0.11/53",
      ]),
    (e) => e.status === 124,
    "Docker DNS stays blocked with home upstream configured",
  );
  const nat = docker([
    "exec",
    gateway,
    "iptables",
    "-t",
    "nat",
    "-S",
    "PREROUTING",
  ]);
  assert.match(nat, /-i wg0 -p udp .*--dport 53 -j REDIRECT --to-ports 5353/);
  assert.match(nat, /-i wg0 -p tcp .*--dport 53 -j REDIRECT --to-ports 5353/);
  const rules = docker(['exec', gateway, 'iptables', '-S', 'OUTPUT']);
  assert.ok(rules.includes(`-d ${upstreamIp}/32 -p udp`) && rules.includes('--dport 8088 -j ACCEPT'));
  assert.ok(rules.includes(`-d ${upstreamIp}/32 -p tcp`));
  console.log('PASS: default outbound deny; only configured UDP/TCP resolver destination and port; forwarding disabled; Docker DNS remains blocked.');
} catch (e) {
  try { process.stderr.write(docker(['logs',gateway])+'\n'); } catch {}
  throw e;
} finally {
  for (const name of [gateway, upstream]) { try { docker(['rm','-f',name]); } catch {} }
  try { docker(['network','rm',prefix]); } catch {}
}
