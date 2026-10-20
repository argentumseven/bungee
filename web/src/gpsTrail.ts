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
