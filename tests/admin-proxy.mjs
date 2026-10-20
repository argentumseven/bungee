import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './support/server.mjs';
test('direct administrator identity ignores forged proxy headers', async t => {
  const f = await fixture(t);
  for (let n=0;n<5;n++) {
    const r = await f.admin('/api/session','POST',{password:'incorrect'}, {'X-Bungee-Admin-IP':`192.0.2.${n+1}`,'X-Forwarded-For':`192.0.2.${n+1}`});
    // fixture login consumes one of the five source attempts.
    assert.equal(r.status,n<4?401:429);
  }
  assert.equal((await f.admin('/api/session','POST',{password:'incorrect'},{'X-Bungee-Admin-IP':'192.0.2.99'})).status,429);
});
