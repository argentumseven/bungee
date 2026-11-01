"""Tiny artificial Protomaps-schema MVT in PMTiles v3. Never production map data."""
import json
import math
import gzip
from pathlib import Path
import struct
import sys

def varint(value):
    result=bytearray()
    while value>=128: result.append((value&127)|128); value>>=7
    result.append(value)
    return bytes(result)
def field(tag,data): return varint(tag*8+2)+varint(len(data))+data
def number(tag,n):return varint(tag*8)+varint(n)

def tile_id(z,x,y):
    n=1<<z;distance=0;side=n//2
    while side:
        rx=1 if x&side else 0;ry=1 if y&side else 0
        distance+=side*side*((3*rx)^ry)
        if not ry:
            if rx:x=n-1-x;y=n-1-y
            x,y=y,x
        side//=2
    return ((1<<(2*z))-1)//3+distance

def archive(path,detail=False):
    # A rectangular synthetic land mass in the earth layer. Geometry uses deltas.
    geometry=b''.join(varint(n) for n in [9,0,0,26,8192,0,0,8192,8191,0,15])
    feature=number(1,1)+number(3,3)+field(4,geometry)
    layer=field(1,b'earth')+field(2,feature)+number(5,4096)+number(15,2)
    tile=field(3,layer)
    root=b''.join(varint(n) for n in [1,0,1,len(tile),1])
    metadata=json.dumps({'name':'Synthetic vector fixture (not street data)','vector_layers':[{'id':'earth','fields':{}}]}).encode()
    tile_count=1
    if detail:
        longitude,latitude=-80,33;z=15;n=1<<z
        x=int((longitude+180)/360*n);fy=(1-math.asinh(math.tan(math.radians(latitude)))/math.pi)/2*n;y=int(fy)
        road_y=int((fy-y)*4096)
        road_geometry=b''.join(varint(value) for value in [9,0,road_y*2,10,8192,0])
        road=number(1,2)+field(2,b'\x00\x00\x01\x01')+number(3,2)+field(4,road_geometry)
        road_layer=field(1,b'roads')+field(2,road)+field(3,b'name')+field(3,b'kind')+field(4,field(1,b'Synthetic Main Street'))+field(4,field(1,b'minor_road'))+number(5,4096)+number(15,2)
        detailed=tile+field(3,road_layer)
        root=b''.join(varint(value) for value in [2,0,tile_id(z,x,y),1,1,len(tile),len(detailed),1,0])
        tile+=detailed
        tile_count=2
        metadata=json.dumps({'name':'Synthetic street fixture','vector_layers':[{'id':'earth','fields':{}},{'id':'roads','fields':{'name':'String'}}]}).encode()
        # The real Protomaps builds use gzip internal directories. go-pmtiles
        # extraction preserves this flag while writing a gzip output directory.
        root=gzip.compress(root,mtime=0);metadata=gzip.compress(metadata,mtime=0)
    header=bytearray(127);header[:8]=b'PMTiles\x03'
    for offset,value in [(8,127),(16,len(root)),(24,127+len(root)),(32,len(metadata)),(40,127+len(root)+len(metadata)),(48,0),(56,127+len(root)+len(metadata)),(64,len(tile)),(72,tile_count),(80,tile_count),(88,tile_count)]:struct.pack_into('<Q',header,offset,value)
    header[96:102]=bytes([1,1,1,1,0,0])
    if detail:header[97]=2;header[101]=15
    for offset,value in [(102,-1800000000),(106,-850000000),(110,1800000000),(114,850000000)]:struct.pack_into('<i',header,offset,value)
    Path(path).write_bytes(header+root+metadata+tile)

if __name__=='__main__': archive(sys.argv[1],detail='--detail' in sys.argv)
