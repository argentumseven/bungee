import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import {once} from 'node:events';
import {tlsFixture} from './support/tls-server.mjs';

test('HTTP/2 authentication and logout read the session across separate Cookie fields',async t=>{
 const f=await tlsFixture(t),client=http2.connect(f.origin,{ca:f.ca,rejectUnauthorized:true,minVersion:'TLSv1.3',ecdhCurve:'X25519MLKEM768'});
 try {
  await once(client,'connect');assert.equal(client.alpnProtocol,'h2');
  const request=(method,path,cookies,body)=>new Promise((resolve,reject)=>{
   const headers={':method':method,':path':path,origin:f.origin,'content-type':'application/json'};
   if(cookies!==undefined)headers.cookie=cookies;
   const stream=client.request(headers);let response,text='';
   stream.on('response',headers=>response=headers);stream.on('data',data=>text+=data);stream.on('error',reject);
   stream.on('end',()=>resolve({status:response[':status'],headers:response,body:text}));stream.end(body===undefined?undefined:JSON.stringify(body));
  });
  const login=await request('POST','/api/session',undefined,{password:f.password});assert.equal(login.status,200);
  const cookie=login.headers['set-cookie'][0].split(';')[0];
  assert.equal((await request('GET','/api/session',cookie)).status,200);
  assert.equal((await request('GET','/api/session',['other_service=fixture',cookie])).status,200,'a preceding unrelated Cookie field must not hide a valid session');
  assert.equal((await request('GET','/api/devices',['one=fixture','two=fixture',cookie])).status,200,'all protected routes use the same parser');
  assert.equal((await request('GET','/api/session',['one=fixture','bungee_session=invalid'])).status,401,'unrelated cookies never authenticate a request');
  assert.equal((await request('GET','/api/session',['one=fixture','two=fixture'])).status,401);
  assert.equal((await request('DELETE','/api/session',['other_service=fixture',cookie])).status,204);
  assert.equal((await request('GET','/api/session',cookie)).status,401,'logout must revoke the actual token, not only clear the browser cookie');
 } finally {client.destroy();}
});
