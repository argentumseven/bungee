import test from "node:test";
import assert from "node:assert/strict";
import {nearestStreet} from "../web/src/mapStreet.ts";
const road=(name,coordinates)=>({properties:{name},geometry:{type:"LineString",coordinates}});
test("nearby road labels use the closest segment, not the first feature or an invented address",()=>{
 const point={latitude:33,longitude:-80};
 const result=nearestStreet(point,[road("Far Road",[[-80.001,33.001],[-79.999,33.001]]),road("Main Street",[[-80.001,33],[-79.999,33]])]);
 assert.equal(result.name,"Main Street");assert.ok(result.metres<1);assert.equal(Object.keys(result).length,2);
});
test("no address label is fabricated for missing names, distant streets or malformed geometry",()=>{
 const point={latitude:33,longitude:-80};
 assert.equal(nearestStreet(point,[road("Distant Road",[[-81,34],[-80.99,34]]),road("",[[-80,33],[-79.9,33]]),road("bad",[[NaN,33],[-80,33]])]),null);
});
