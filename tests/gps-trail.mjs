import test from "node:test";
import assert from "node:assert/strict";
import {gpsTrail} from "../web/src/gpsTrail.ts";
const p=(latitude,longitude,observed_at,accuracy=10)=>({latitude,longitude,observed_at,accuracy});
test("uncertain fix omitted, raw retained",()=>{
 const raw=[p(32,-80,100),p(33,-81,160,400),p(32.0001,-80,220)];
 const result=gpsTrail(raw);
 assert.equal(result.ignored,1);assert.equal(raw.length,3);assert.deepEqual(result.segments.map(x=>x.length),[2]);
});
test("quick A-B-A GPS spike omitted",()=>{
 const raw=[p(32,-80,100),p(33,-80,160),p(32.00001,-80,220)];
 assert.equal(gpsTrail(raw).ignored,1);
});
test("plausible travel retained",()=>{
 assert.equal(gpsTrail([p(32,-80,100),p(32.015,-80,160),p(32.03,-80,220)]).points.length,3);
});
test("long gaps and jumps split segments",()=>{
 assert.deepEqual(gpsTrail([p(32,-80,100),p(32.0001,-80,160),p(32.0002,-80,1000),p(35,-80,1060)]).segments.map(x=>x.length),[2,1,1]);
});
test("invalid coordinates and accuracy omitted",()=>{
 assert.equal(gpsTrail([p(32,-80,100),p(100,-80,160),p(32,NaN,220),{latitude:32,longitude:-80,observed_at:280}]).points.length,1);
});
