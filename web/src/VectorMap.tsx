import {useEffect,useRef,useState} from "react";
import maplibregl, {type LayerSpecification} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-csp-worker.js?url";
import {Protocol} from "pmtiles";
import {layers,namedFlavor} from "@protomaps/basemaps";
import "maplibre-gl/dist/maplibre-gl.css";
import {gpsTrail,savedPosition,uncertainPosition,type GpsPoint} from "./gpsTrail";
import {nearestStreet} from "./mapStreet";
import type {NetworkObservation} from "./PrivateMap";

maplibregl.setWorkerUrl(workerUrl);
maplibregl.addProtocol("pmtiles",new Protocol().tile);
export type MapRegion={id:string;name:string;min_zoom:number;max_zoom:number;bounds?:number[]};
export default function VectorMap({points,selected,network,label,regions=[],legacy=false,overview=false}:{points:GpsPoint[];selected?:GpsPoint|null;network?:NetworkObservation|null;label:string;regions?:MapRegion[];legacy?:boolean;overview?:boolean}) {
 const element=useRef<HTMLDivElement>(null),map=useRef<maplibregl.Map|null>(null);
 const [error,setError]=useState(""),[street,setStreet]=useState(""),[covered,setCovered]=useState<boolean|null>(null);
 const signature=JSON.stringify({points,selected,network,regions,legacy,overview});
 useEffect(()=>{
  if(!element.current)return;
  setError("");setStreet("");setCovered(null);
  const sources:Record<string,maplibregl.SourceSpecification>={};
  const styleLayers:LayerSpecification[]=[{id:"background",type:"background",paint:{"background-color":"#e9e7df"}}];
  if(overview){sources.overview={type:"raster",tiles:[`${window.location.origin}/api/maps/{z}/{x}/{y}`],tileSize:256,minzoom:0,maxzoom:6};styleLayers.push({id:"world-overview",type:"raster",source:"overview"});}
  const archives=[...(legacy?[{id:"legacy",url:"/api/maps/archive.pmtiles"}]:[]),...regions.map(r=>({id:r.id,url:`/api/maps/regions/${r.id}/archive.pmtiles`}))];
  for(const archive of archives){
   const source=`streets-${archive.id}`;
   sources[source]={type:"vector",url:`pmtiles://${window.location.origin}${archive.url}`};
   const base=layers(source,namedFlavor("light"),{lang:"en"}).filter(layer=>layer.type!=="background").map(layer=>{
    const layout=layer.type==="symbol"&&layer.layout?.["text-field"]?{...layer.layout,"text-font":["Noto Sans Regular"]}:layer.layout;
    return {...layer,id:`${archive.id}-${layer.id}`,...(layout?{layout}:{})};
   }) as LayerSpecification[];
   styleLayers.push(...base);
  }
  let m:maplibregl.Map;
  try {m=new maplibregl.Map({container:element.current,attributionControl:false,center:[-98,39],zoom:3,maxZoom:20,style:{version:8,glyphs:`${window.location.origin}/map-assets/fonts/{fontstack}/{range}.pbf`,sprite:`${window.location.origin}/map-assets/sprites/light`,sources,layers:styleLayers}});}catch{setError("Street map rendering needs WebGL enabled in this browser.");return;}
  map.current=m;
  m.addControl(new maplibregl.NavigationControl(),"top-left");m.addControl(new maplibregl.ScaleControl({unit:"metric"}),"bottom-left");m.scrollZoom.disable();
  m.on("error",()=>setError("Some map tiles are unavailable. Check downloaded coverage in Maps & storage."));
  const clean=gpsTrail(points),focus=savedPosition(points,selected);
  if(focus){
   const dot=document.createElement("div");dot.className=`saved-gps-marker${uncertainPosition(focus)?" uncertain":""}`;dot.setAttribute("role","img");dot.setAttribute("aria-label","Last saved GPS position");
   dot.title=`Saved ${focus.observed_at?new Date(focus.observed_at*1000).toLocaleString():"time unknown"} · ${focus.accuracy!==undefined?`reported accuracy ±${Math.round(focus.accuracy)} m`:"accuracy unknown"}`;
   new maplibregl.Marker({element:dot}).setLngLat([focus.longitude,focus.latitude]).addTo(m);
   m.jumpTo({center:[focus.longitude,focus.latitude],zoom:uncertainPosition(focus)?11:16});
  }
  m.on("idle",()=>{
   const center=m.project(m.getCenter());
   setCovered(m.queryRenderedFeatures([[center.x-4,center.y-4],[center.x+4,center.y+4]]).some(feature=>feature.source.startsWith("streets-")));
   if(!focus||uncertainPosition(focus)||m.getZoom()<14){setStreet("");return;}
   const pixel=m.project([focus.longitude,focus.latitude]);
   const features=m.queryRenderedFeatures([[pixel.x-80,pixel.y-80],[pixel.x+80,pixel.y+80]]).filter(f=>f.sourceLayer==="roads");
   const nearby=nearestStreet(focus,features);
   setStreet(nearby?`Nearby mapped street: ${nearby.name} · about ${Math.round(nearby.metres)} m away. Approximate map label, not a verified postal address.`:"");
  });
  m.on("style.load",()=>{
   const features:GeoJSON.Feature[]=[];
   for(const segment of clean.segments)if(segment.length>1)features.push({type:"Feature",properties:{kind:"trail"},geometry:{type:"LineString",coordinates:segment.map(p=>[p.longitude,p.latitude])}});
   for(const p of clean.points.filter(p=>p.observed_at!==focus?.observed_at))features.push({type:"Feature",properties:{kind:"gps",selected:p.observed_at===focus?.observed_at},geometry:{type:"Point",coordinates:[p.longitude,p.latitude]}});
   if(focus?.accuracy){const ring:number[][]=[];for(let i=0;i<=64;i++){const a=i/64*Math.PI*2;ring.push([focus.longitude+Math.cos(a)*focus.accuracy/(111320*Math.max(0.01,Math.cos(focus.latitude*Math.PI/180))),focus.latitude+Math.sin(a)*focus.accuracy/111320]);}features.push({type:"Feature",properties:{kind:"uncertainty"},geometry:{type:"Polygon",coordinates:[ring]}});}
   const geo=network?.geoip;
   if(geo?.latitude!=null&&geo.longitude!=null)features.push({type:"Feature",properties:{kind:"ip"},geometry:{type:"Point",coordinates:[geo.longitude,geo.latitude]}});
   m.addSource("observations",{type:"geojson",data:{type:"FeatureCollection",features}});
   m.addLayer({id:"uncertainty",type:"fill",source:"observations",filter:["==","kind","uncertainty"],paint:{"fill-color":"#4d8797","fill-opacity":0.15}});
   m.addLayer({id:"trail",type:"line",source:"observations",filter:["==","kind","trail"],paint:{"line-color":"#356b81","line-width":3}});
   m.addLayer({id:"gps",type:"circle",source:"observations",filter:["==","kind","gps"],paint:{"circle-color":"#79b5c0","circle-radius":["case",["==",["get","selected"],true],8,4],"circle-stroke-width":2,"circle-stroke-color":"#234d60"}});
   m.addLayer({id:"ip",type:"circle",source:"observations",filter:["==","kind","ip"],paint:{"circle-color":"#e8b76b","circle-radius":8,"circle-stroke-width":2,"circle-stroke-color":"#a46818"}});
   if(focus)m.jumpTo({center:[focus.longitude,focus.latitude],zoom:uncertainPosition(focus)?11:16});
   else if(geo?.latitude!=null&&geo.longitude!=null)m.jumpTo({center:[geo.longitude,geo.latitude],zoom:7});
  });
  const resize=new ResizeObserver(()=>m.resize());resize.observe(element.current);
  return()=>{resize.disconnect();map.current=null;m.remove();};
 },[signature]);
 const showAll=()=>{const clean=gpsTrail(points).points;if(!clean.length)return;const b=new maplibregl.LngLatBounds();for(const p of clean)b.extend([p.longitude,p.latitude]);map.current?.fitBounds(b,{padding:45,maxZoom:16});};
 return <div className="private-map-wrap"><div className="private-map" ref={element} role="img" aria-label={label}/><div className="private-map-key"><span className="gps-key">● GPS</span><span className="ip-key">● Approximate IP area</span>{points.length>1&&<button type="button" onClick={showAll}>Show all loaded points</button>}{network?.geoip?.latitude!=null&&network.geoip.longitude!=null&&<button type="button" onClick={()=>map.current?.jumpTo({center:[network.geoip!.longitude!,network.geoip!.latitude!],zoom:7})}>Show IP estimate</button>}<button type="button" onClick={()=>window.dispatchEvent(new Event("bungee:maps"))}>Manage maps</button></div><div className="private-map-status" role="status">{error||(covered===false?"No local street detail visible here · check downloaded coverage in Maps & storage":`Local street map · ${regions.length||1} archive${regions.length>1?"s":""} · no external provider requests`)}</div>{street&&<p className="map-street-label">{street}</p>}<div className="map-attribution">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a> · Protomaps{overview&&" · Natural Earth"}</div></div>;
}
