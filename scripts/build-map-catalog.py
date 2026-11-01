#!/usr/bin/env python3
"""Build public regional boundaries from Natural Earth 5.1.2 (maintainer tool)."""
import argparse
import hashlib
import json
import math
from pathlib import Path

US = [
    ('us-northeast','Northeast','ME NH VT MA RI CT NY NJ PA',57_600_000),
    ('us-midwest','Midwest','OH IN IL MI WI IA KS MN MO NE ND SD',69_000_000),
    ('us-south-atlantic','South Atlantic','DE DC FL GA MD NC SC VA WV',67_000_000),
    ('us-south-central','South Central','AL KY MS TN AR LA OK TX',60_000_000),
    ('us-mountain','Mountain','AZ CO ID MT NV NM UT WY',25_000_000),
    ('us-pacific','Pacific','CA OR WA',52_000_000),
    ('us-alaska','Alaska','AK',735_000),
    ('us-hawaii','Hawaii','HI',1_450_000),
]

def polygons(geometry):
    return geometry['coordinates'] if geometry['type']=='MultiPolygon' else [geometry['coordinates']]

def make_region(identifier, name, group, geometries, population):
    shapes=[polygon for geometry in geometries for polygon in polygons(geometry)]
    points=[p for polygon in shapes for ring in polygon for p in ring]
    bounds=[min(p[0] for p in points),min(p[1] for p in points),max(p[0] for p in points),max(p[1] for p in points)]
    area=0
    for polygon in shapes:
        ring=polygon[0]
        area+=abs(sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(ring,ring[1:])))/2*111.32**2*max(.05,math.cos(math.radians(sum(p[1] for p in ring)/len(ring))))
    # Deliberately rough catalogue guidance. The real extraction plan is mandatory.
    estimate=int((32*1024**2+max(0,population)*12+area*180)/(32*1024**2)+1)*32*1024**2
    return {'id':identifier,'name':name,'group':group,'estimated_bytes':estimate,'max_zoom':15,'bounds':bounds,
            'geometry':{'type':'MultiPolygon','coordinates':shapes}}

def build(countries, states):
    regions=[]
    features=json.loads(states.read_text())['features']
    us=[f for f in features if f['properties'].get('admin')=='United States of America']
    for identifier,name,postals,pop in US:
        selected=[f['geometry'] for f in us if f['properties']['postal'] in postals.split()]
        if len(selected)!=len(postals.split()): raise ValueError('Missing US state boundary')
        regions.append(make_region(identifier,name,'United States',selected,pop))
    for f in json.loads(countries.read_text())['features']:
        p=f['properties']; iso=p['ADM0_A3'].lower()
        if iso in ('usa','ata'): continue
        regions.append(make_region(iso,p['ADMIN'],p['CONTINENT'],[f['geometry']],p.get('POP_EST',0)))
    regions.sort(key=lambda r:(r['group']!='United States',r['group'],r['name']))
    return {'format':1,'source':'Natural Earth 5.1.2, public domain','size_note':'Rough estimates; an exact download plan is required before installation.',
            'source_sha256':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (countries,states)},'regions':regions}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--countries',type=Path,required=True)
    parser.add_argument('--states',type=Path,required=True)
    parser.add_argument('--output',type=Path,default=Path('basemap/regions.json'))
    args=parser.parse_args()
    args.output.write_text(json.dumps(build(args.countries,args.states),separators=(',',':'))+'\n')
