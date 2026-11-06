import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash, randomUUID, randomBytes } from "node:crypto";
export async function phone(f,{name="Adversarial fixture",primaryDeviceId,capabilities=["locate"],profiles=false,runtime=false,fingerprint,bundle: suppliedBundle}={}) {
  const key=generateKeyPairSync("ec",{namedCurve:"P-256"});
  const publicKey=key.publicKey.export({type:"spki",format:"der"}).toString("base64");
  const wg=suppliedBundle?.wireguard.client_public_key??randomBytes(32).toString("base64");
  fingerprint??=createHash("sha256").update(randomUUID()).digest("hex");
  runtime ||= profiles||!!primaryDeviceId;
  const invitation=suppliedBundle?null:await f.admin("/api/enrollments","POST",{name,wg_public_key:wg,...(primaryDeviceId?{primary_device_id:primaryDeviceId}:{}),...(profiles?{main_profile_name:"Owner"}:{})});
  if(invitation)assert.equal(invitation.status,200);const bundle=suppliedBundle??await invitation.json();
  const proof=sign("sha256",Buffer.from(`BUNGEE-ENROLL-V1\n${bundle.token}\n${wg}\n${publicKey}`),key.privateKey).toString("base64");
  const enrolled=await f.device("/v1/enroll",{token:bundle.token,public_key:publicKey,wg_public_key:wg,proof,capabilities,...(runtime?{runtime_protocol:1}:{}),...(!bundle.profile?{}:{profile_fingerprint:fingerprint}),...(primaryDeviceId?{profile_companion:true}:{})});
  assert.equal(enrolled.status,200); const state=await enrolled.json();
  let lease,sequence=0;
  const prepare=(path,body,{session=lease,raw=false}={})=>{
    if(session&&path==="/v1/sync"&&!raw&&Object.keys(body.report||{}).length)body={...body,report:{...body.report,runtime_sequence:++sequence,...(bundle.profile?{profile_fingerprint:fingerprint}:{})}};
    const text=JSON.stringify(body),at=String(Math.floor(Date.now()/1000)),nonce=randomUUID();
    const canonical=`${session?"BUNGEE-V2":"BUNGEE-V1"}\nPOST\n${path}\n${at}\n${nonce}\n${createHash("sha256").update(text).digest("hex")}${session?`\n${session.instance}\n${session.secret}`:""}`;
    return {text,headers:{"Content-Type":"application/json","X-Bungee-Device":bundle.device_id,...(session?{"X-Bungee-Instance":session.instance,"X-Bungee-Runtime":session.secret}:{}),"X-Bungee-Time":at,"X-Bungee-Nonce":nonce,"X-Bungee-Signature":sign("sha256",Buffer.from(canonical),key.privateKey).toString("base64")}};
  };
  const request=(path,body,options)=>{const p=prepare(path,body,options);return fetch(f.deviceOrigin+path,{method:"POST",headers:p.headers,body:p.text});};
  const acquire=async(candidate={instance:randomUUID(),secret:randomBytes(32).toString("base64url")},previous=[])=>{
    const r=await request("/v1/runtime",{...candidate,previous,...(bundle.profile?{profile_fingerprint:fingerprint}:{})},{session:null});
    if(r.ok)lease=candidate;
    return r;
  };
  if(runtime)assert.equal((await acquire()).status,200);
  return {acquire,get lease(){return lease;},fingerprint,id:bundle.device_id,epoch:state.gps_epoch,photoEpoch:state.photo_epoch,bundle,prepare,request};
}
