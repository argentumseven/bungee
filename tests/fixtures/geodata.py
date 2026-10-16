#!/usr/bin/env python3
"""Generate clearly synthetic raster coverage for offline API/browser tests, not street data."""
import math
from pathlib import Path
import shutil
import sqlite3
import struct
import sys
import zlib


def create(root):
    root = Path(root); root.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(Path(__file__).with_name('GeoIP2-City-Test.mmdb'), root / 'geoip.mmdb')
    def chunk(kind, data): return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
    # A neutral grid makes a missing real basemap unmistakable. No invented streets or landmarks.
    pixels = b''.join(b'\0' + b''.join(bytes((220,225,214) if x % 64 == 0 or y % 64 == 0 else (242,243,235)) for x in range(256)) for y in range(256))
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB',256,256,8,2,0,0,0)) + chunk(b'IDAT',zlib.compress(pixels)) + chunk(b'IEND',b'')
    db = sqlite3.connect(root / 'map.mbtiles')
    db.executescript('CREATE TABLE metadata(name TEXT,value TEXT); CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB,PRIMARY KEY(zoom_level,tile_column,tile_row));')
    db.executemany('INSERT INTO metadata VALUES(?,?)',[('format','png'),('minzoom','0'),('maxzoom','18'),('name','Synthetic test grid (not street data)'),('attribution','Synthetic coverage for automated tests')])
    for lat,lon in [(37.78,-122.42),(51.5142,-0.0931)]:
        for zoom in range(19):
            x = int((lon+180)/360*(1<<zoom)); y = int((1-math.asinh(math.tan(math.radians(lat)))/math.pi)/2*(1<<zoom))
            for dx in range(-3,4):
                for dy in range(-3,4):
                    tx,ty=x+dx,y+dy
                    if 0 <= tx < 1<<zoom and 0 <= ty < 1<<zoom:
                        db.execute('INSERT OR IGNORE INTO tiles VALUES(?,?,?,?)',(zoom,tx,(1<<zoom)-1-ty,png))
    db.commit(); db.close()


if __name__ == '__main__': create(sys.argv[1])
