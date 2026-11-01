"""Tiny artificial Protomaps-schema MVT in PMTiles v3. Never production map data."""
import json
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

def archive(path):
    # A rectangular synthetic land mass in the earth layer. Geometry uses deltas.
    geometry=b''.join(varint(n) for n in [9,0,0,26,8192,0,0,8192,8191,0,15])
    feature=number(1,1)+number(3,3)+field(4,geometry)
    layer=field(1,b'earth')+field(2,feature)+number(5,4096)+number(15,2)
    tile=field(3,layer)
    root=b''.join(varint(n) for n in [1,0,1,len(tile),1])
    metadata=json.dumps({'name':'Synthetic vector fixture (not street data)','vector_layers':[{'id':'earth','fields':{}}]}).encode()
    header=bytearray(127);header[:8]=b'PMTiles\x03'
    for offset,value in [(8,127),(16,len(root)),(24,127+len(root)),(32,len(metadata)),(40,127+len(root)+len(metadata)),(48,0),(56,127+len(root)+len(metadata)),(64,len(tile)),(72,1),(80,1),(88,1)]:struct.pack_into('<Q',header,offset,value)
    header[96:102]=bytes([1,1,1,1,0,0])
    for offset,value in [(102,-1800000000),(106,-850000000),(110,1800000000),(114,850000000)]:struct.pack_into('<i',header,offset,value)
    Path(path).write_bytes(header+root+metadata+tile)

if __name__=='__main__': archive(sys.argv[1])
