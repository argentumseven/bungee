import type {GpsPoint} from "./gpsTrail";
type Road={properties?:Record<string,unknown>|null;geometry:{type:string;coordinates?:unknown}};
/** Nearby road label only; never infer a building number or postal address. */
export function nearestStreet(point:GpsPoint,features:readonly Road[]):{name:string;metres:number}|null {
 let best:{name:string;metres:number}|null=null;
 const scaleX=111320*Math.cos(point.latitude*Math.PI/180),scaleY=111320;
 for(const feature of features){
  const name=feature.properties?.["name:en"]??feature.properties?.name;
  if(typeof name!=="string"||!name.trim()||name.length>200)continue;
  const paths=feature.geometry.type==="LineString"?[feature.geometry.coordinates]:feature.geometry.type==="MultiLineString"?feature.geometry.coordinates:[];
  if(!Array.isArray(paths))continue;
  for(const path of paths){if(!Array.isArray(path))continue;for(let i=1;i<path.length;i++){
   const a=path[i-1],b=path[i];if(!Array.isArray(a)||!Array.isArray(b)||![...a,...b].every(Number.isFinite))continue;
   const ax=(a[0]-point.longitude)*scaleX,ay=(a[1]-point.latitude)*scaleY,bx=(b[0]-point.longitude)*scaleX,by=(b[1]-point.latitude)*scaleY;
   const dx=bx-ax,dy=by-ay,t=Math.max(0,Math.min(1,-(ax*dx+ay*dy)/(dx*dx+dy*dy||1)));
   const metres=Math.hypot(ax+t*dx,ay+t*dy);
   if(metres<=200&&(!best||metres<best.metres))best={name:name.trim(),metres};
  }}
 }
 return best;
}
