export type ImportedPoint={observed_at:number;received_at:number;latitude:number;longitude:number;accuracy:number;source:string;samples:number;system_vpn:boolean|null};
export function parseGpsCsv(text:string):ImportedPoint[]{
 const lines=text.replace(/^\uFEFF/,"").trim().split(/\r?\n/);
 if(lines.length<2||lines.length>100001)throw Error("Choose a Bungee GPS CSV with 1–100,000 rows.");
 const fields=(line:string)=>line.split(",").map(s=>s.replace(/^"(.*)"$/,'$1'));
 const header=fields(lines[0]);
 const expected=["observed_at_utc","received_at_utc","latitude","longitude","accuracy_m","source","samples","system_vpn"];
 if(header.join(",")!==expected.join(","))throw Error("Choose a Bungee GPS history CSV with the original eight columns.");
 return lines.slice(1).map((line,index)=>{
  const f=fields(line),number=(i:number)=>f[i]?.trim()?Number(f[i]):NaN;
  const p={observed_at:Date.parse(f[0])/1000,received_at:Date.parse(f[1])/1000,latitude:number(2),longitude:number(3),accuracy:number(4),source:f[5],samples:number(6),system_vpn:f[7]===""?null:f[7]==="true"?true:f[7]==="false"?false:undefined};
  if(f.length!==8||!f[0].endsWith("Z")||!f[1].endsWith("Z")||!Number.isInteger(p.observed_at)||p.observed_at<=0||p.observed_at>Date.now()/1000+120||!Number.isInteger(p.received_at)||p.received_at<=0||p.received_at>Date.now()/1000+120||!Number.isFinite(p.latitude)||Math.abs(p.latitude)>90||!Number.isFinite(p.longitude)||Math.abs(p.longitude)>180||!Number.isFinite(p.accuracy)||p.accuracy<0||p.accuracy>100000||!Number.isInteger(p.samples)||p.samples<1||p.samples>1000||!["passive","homing","haste","best_guess"].includes(p.source)||p.system_vpn===undefined)throw Error(`Invalid GPS CSV row ${index+2}. No rows have been imported.`);
  return p as ImportedPoint;
 });
}
