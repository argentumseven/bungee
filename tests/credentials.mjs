import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {readFile, access, mkdtemp, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fixture} from './support/server.mjs';

test('password change persists only a salted verifier, revokes all sessions and survives restart', async t => {
  const s = await fixture(t);
  const oldCookie = s.cookie;
  const second = await s.admin('/api/session', 'POST', {password:s.password});
  assert.equal(second.status, 200);
  const secondCookie = second.headers.get('set-cookie').split(';')[0];
  const password = '  a different long passphrase 🔐  ';
  const changed = await s.admin('/api/password', 'POST', {current_password:s.password, new_password:password});
  assert.equal(changed.status, 200);
  assert.match(changed.headers.get('set-cookie'), /Max-Age=0/);
  for (const Cookie of [oldCookie, secondCookie]) {
    assert.equal((await s.admin('/api/session', 'GET', undefined, {Cookie})).status, 401);
  }
  assert.equal((await s.admin('/api/session', 'POST', {password:s.password})).status, 401);
  await s.login(password);
  await assert.rejects(access(join(s.dir,'admin-password')));
  await assert.rejects(access(join(s.dir,'admin-password.hash')));
  const verifier = s.sql('SELECT hash FROM admin_credential')[0][0];
  assert.match(verifier, /^\$argon2id\$v=19\$/);
  for (const file of ['bungee.sqlite3', 'bungee.sqlite3-wal']) {
    const data = await readFile(join(s.dir,file));
    assert.ok(!data.includes(Buffer.from(password)));
    assert.ok(!data.includes(Buffer.from(s.password)));
  }
  await s.stop();
  await s.launch(password);
  assert.equal((await s.admin('/api/session')).status, 200);
});

test('legacy migration removes plaintext; invalid password changes preserve credentials and sessions', async t => {
  const s = await fixture(t, {legacy:true});
  await assert.rejects(access(join(s.dir,'admin-password')));
  const before = s.sql('SELECT hash FROM admin_credential')[0][0];
  assert.equal((await s.admin('/api/password', 'POST', {current_password:'wrong',new_password:'a new sufficiently long password'})).status,400);
  assert.equal((await s.admin('/api/password', 'POST', {current_password:s.password,new_password:'short'})).status,400);
  assert.equal((await s.admin('/api/password', 'POST', {current_password:s.password,new_password:'an invalid password\n'})).status,400);
  assert.equal((await s.admin('/api/password', 'POST', {current_password:s.password,new_password:'a new sufficiently long password'}, {Origin:'https://untrusted.example'})).status,403);
  assert.equal(s.sql('SELECT hash FROM admin_credential')[0][0], before);
  assert.equal((await s.admin('/api/session')).status,200);
});

test('local password reset works without restart and invalidates the logged-in browser', async t => {
  const s = await fixture(t);
  const password = 'local reset passphrase for this test';
  execFileSync(resolve('server/target/debug/bungee-server'), ['--set-admin-password'], {
    env:{...process.env,BUNGEE_STATE_DIR:s.dir}, input:password, stdio:['pipe','pipe','pipe'],
  });
  assert.equal((await s.admin('/api/session')).status,401);
  await s.login(password);
});

test('a missing administrator credential fails closed instead of generating a plaintext default', async t => {
  const dir = await mkdtemp(join(tmpdir(),'bungee-no-password-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const child = spawnSync(resolve('server/target/debug/bungee-server'), [], {env:{...process.env,BUNGEE_STATE_DIR:dir},encoding:'utf8'});
  assert.notEqual(child.status,0);
  assert.match(child.stderr,/password is not configured/);
  await assert.rejects(access(join(dir,'admin-password')));
});
