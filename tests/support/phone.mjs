import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash, randomUUID, randomBytes } from "node:crypto";
export async function phone(f,{name="Adversarial fixture",primaryDeviceId,capabilities=["locate"]}={}) {
  const key=generateKeyPairSync("ec",{namedCurve:"P-256"});
  const publicKey=key.publicKey.export({type:"spki",format:"der"}).toString("base64");
  const wg=randomBytes(32).toString("base64");
  const invitation=await f.admin("/api/enrollments","POST",{name,wg_public_key:wg,...(primaryDeviceId?{primary_device_id:primaryDeviceId}:{})});
  assert.equal(invitation.status,200);const bundle=await invitation.json();
  const proof=sign("sha256",Buffer.from(`BUNGEE-ENROLL-V1\n${bundle.token}\n${wg}\n${publicKey}`),key.privateKey).toString("base64");
  const enrolled=await f.device("/v1/enroll",{token:bundle.token,public_key:publicKey,wg_public_key:wg,proof,capabilities,...(primaryDeviceId?{profile_companion:true}:{})});
  assert.equal(enrolled.status,200); const state=await enrolled.json();
  const prepare=(path,body)=>{
    const text=JSON.stringify(body),at=String(Math.floor(Date.now()/1000)),nonce=randomUUID();
    return {text,headers:{"Content-Type":"application/json","X-Bungee-Device":bundle.device_id,"X-Bungee-Time":at,"X-Bungee-Nonce":nonce,"X-Bungee-Signature":sign("sha256",Buffer.from(`BUNGEE-V1\nPOST\n${path}\n${at}\n${nonce}\n${createHash("sha256").update(text).digest("hex")}`),key.privateKey).toString("base64")}};
  };
  const request=(path,body)=>{const p=prepare(path,body);return fetch(f.deviceOrigin+path,{method:"POST",headers:p.headers,body:p.text});};
  return {id:bundle.device_id,epoch:state.gps_epoch,photoEpoch:state.photo_epoch,bundle,prepare,request};
}
