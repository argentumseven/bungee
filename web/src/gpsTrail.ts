/** Presentation-only GPS filtering; raw history and exports remain intact. */
export type GpsPoint={latitude:number;longitude:number;accuracy?:number;observed_at?:number};
const rad=(v:number)=>v*Math.PI/180;
function distance(a:GpsPoint,b:GpsPoint):number{
 const x=rad(b.latitude-a.latitude),y=rad(b.longitude-a.longitude);
 const h=Math.sin(x/2)**2+Math.cos(rad(a.latitude))*Math.cos(rad(b.latitude))*Math.sin(y/2)**2;
 return 12742000*Math.asin(Math.min(1,Math.sqrt(h)));
}
function valid(p:GpsPoint):boolean{
 return Number.isFinite(p.latitude)&&Number.isFinite(p.longitude)&&p.latitude>=-90&&p.latitude<=90&&p.longitude>=-180&&p.longitude<=180&&
 p.accuracy!==undefined&&Number.isFinite(p.accuracy)&&p.accuracy>=0&&p.accuracy<=100;
}
/** A dated saved position remains useful even when it cannot form a reliable trail. */
export function savedPosition<T extends GpsPoint>(raw:readonly T[],selected?:T|null):T|null {
 const usable=(point:T)=>Number.isFinite(point.latitude)&&Number.isFinite(point.longitude)&&Math.abs(point.latitude)<=90&&Math.abs(point.longitude)<=180;
 if(selected&&usable(selected))return selected;
 return raw.filter(usable).reduce<T|null>((last,point)=>!last||(point.observed_at??0)>(last.observed_at??0)?point:last,null);
}
export function uncertainPosition(point:GpsPoint):boolean {
 return point.accuracy===undefined||!Number.isFinite(point.accuracy)||point.accuracy>100;
}
function dt(a:GpsPoint,b:GpsPoint):number{
 if(!Number.isFinite(a.observed_at)||!Number.isFinite(b.observed_at))return 0;
 return b.observed_at!-a.observed_at!;
}
function spike(a:GpsPoint,b:GpsPoint,c:GpsPoint):boolean{
 const ab=dt(a,b),bc=dt(b,c);
 if(ab<=0||bc<=0||ab>300||bc>300)return false;
 const x=distance(a,b),y=distance(b,c);
 return x>750&&y>750&&
  Math.max(0,x-a.accuracy!-b.accuracy!)/ab>50&&
  Math.max(0,y-b.accuracy!-c.accuracy!)/bc>50&&
  distance(a,c)<=Math.max(150,2*(a.accuracy!+c.accuracy!));
}
function join(a:GpsPoint,b:GpsPoint):boolean{
 const seconds=dt(a,b);
 return seconds>0&&seconds<=600&&Math.max(0,distance(a,b)-a.accuracy!-b.accuracy!)/seconds<=120;
}
export function gpsTrail<T extends GpsPoint>(raw:readonly T[]):{points:T[];segments:T[][];ignored:number}{
 const good=raw.filter(valid).sort((a,b)=>(a.observed_at??0)-(b.observed_at??0));
 const points=good.filter((p,i)=>i===0||i===good.length-1||!spike(good[i-1],p,good[i+1]));
 const segments:T[][]=[];
 for(const p of points){const last=segments[segments.length-1];if(!last||!join(last[last.length-1],p))segments.push([p]);else last.push(p);}
 return {points,segments,ignored:raw.length-points.length};
}

/** Current stationary estimate uses at most five minutes; raw history stays untouched. */
export function currentEstimate<T extends GpsPoint>(raw:readonly T[]):(GpsPoint & {samples:number;moving:boolean})|null {
 const points=gpsTrail(raw).points;
 const latest=points.at(-1); if(!latest?.observed_at)return null;
 const recent=points.filter(p=>p.observed_at!>=latest.observed_at!-300);
 if(recent.length===1)return {...latest,samples:1,moving:false};
 if(distance(recent[0],latest)>Math.max(30,recent[0].accuracy!+latest.accuracy!))return {...latest,samples:1,moving:true};
 const anchor=recent.reduce((a,b)=>recent.reduce((s,p)=>s+distance(a,p),0)<=recent.reduce((s,p)=>s+distance(b,p),0)?a:b);
 const good=recent.filter(p=>distance(p,anchor)<=Math.max(30,2*(p.accuracy!+anchor.accuracy!)));
 let x=0,y=0,z=0,total=0,radius=0;
 for(const p of good){const w=1/Math.max(5,p.accuracy!)**2;total+=w;x+=Math.cos(rad(p.latitude))*Math.cos(rad(p.longitude))*w;y+=Math.cos(rad(p.latitude))*Math.sin(rad(p.longitude))*w;z+=Math.sin(rad(p.latitude))*w;radius+=p.accuracy!**2*w;}
 const center={latitude:Math.atan2(z,Math.hypot(x,y))*180/Math.PI,longitude:Math.atan2(y,x)*180/Math.PI};
 const spread=Math.sqrt(good.reduce((n,p)=>n+distance(center,p)**2,0)/good.length);
 return {...center,accuracy:Math.max(5,spread,Math.sqrt(radius/total)),observed_at:latest.observed_at,samples:good.length,moving:false};
}
