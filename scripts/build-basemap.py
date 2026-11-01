#!/usr/bin/env python3
"""Build the bundled, public-domain world overview from Natural Earth 5.1.2.

Maintainer-only: python3 scripts/build-basemap.py --source work/basemap-source
Requires Pillow. Does not contact a tile service or use phone locations.
"""
import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import sqlite3
from PIL import Image, ImageDraw, ImageFont


def project(lon, lat):
    lat = max(-85.05112878, min(85.05112878, lat))
    return (lon + 180) / 360, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2


def build(source, target):
    polygons = []
    countries = json.loads((source / 'countries.geojson').read_text())['features']
    for feature in countries:
        geometry = feature['geometry']
        parts = geometry['coordinates'] if geometry['type'] == 'MultiPolygon' else [geometry['coordinates']]
        for part in parts:
            rings = [[project(*point[:2]) for point in ring] for ring in part]
            xs, ys = zip(*rings[0])
            polygons.append((min(xs), min(ys), max(xs), max(ys), rings))
    places = []
    for feature in json.loads((source / 'places.geojson').read_text())['features']:
        properties = feature['properties']
        places.append((*project(*feature['geometry']['coordinates'][:2]), properties['NAMEASCII'], properties['SCALERANK']))
    places.sort(key=lambda item: item[3])
    font = ImageFont.truetype('DejaVuSans.ttf', 11)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.unlink(missing_ok=True)
    db = sqlite3.connect(target)
    db.executescript('CREATE TABLE metadata(name TEXT PRIMARY KEY,value TEXT); CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB,PRIMARY KEY(zoom_level,tile_column,tile_row));')
    metadata = {'name':'Bundled world overview', 'description':'Land, country boundaries and major towns. Regional street detail is installed separately.', 'format':'png', 'type':'baselayer', 'minzoom':'0', 'maxzoom':'6', 'bounds':'-180,-85.05112878,180,85.05112878', 'attribution':'Natural Earth 5.1.2 · public domain', 'bungee_map_kind':'overview'}
    db.executemany('INSERT INTO metadata VALUES(?,?)', metadata.items())
    for zoom in range(7):
        size = 256 * (1 << zoom)
        for x in range(1 << zoom):
            for y in range(1 << zoom):
                image = Image.new('RGB', (256, 256), '#c9dfeb')
                draw = ImageDraw.Draw(image)
                left, top = x * 256, y * 256
                for west, north, east, south, rings in polygons:
                    if east * size < left or west * size > left + 256 or south * size < top or north * size > top + 256: continue
                    for index, ring in enumerate(rings):
                        draw.polygon([(px * size - left, py * size - top) for px, py in ring], fill='#f1efe5' if index == 0 else '#c9dfeb', outline='#a2b5a5')
                occupied = []
                for px, py, name, rank in places:
                    if rank > max(0, zoom - 1): continue
                    tx, ty = px * size - left, py * size - top
                    if not -100 < tx < 256 or not -16 < ty < 256: continue
                    box = draw.textbbox((tx + 5, ty - 8), name, font=font)
                    if any(not (box[2] < b[0] or box[0] > b[2] or box[3] < b[1] or box[1] > b[3]) for b in occupied): continue
                    occupied.append(box)
                    draw.ellipse((tx-2, ty-2, tx+2, ty+2), fill='#526574')
                    draw.text((tx+5, ty-8), name, font=font, fill='#344b59', stroke_width=1, stroke_fill='#f1efe5')
                buffer = io.BytesIO()
                image.save(buffer, format='PNG', optimize=True)
                db.execute('INSERT INTO tiles VALUES(?,?,?,?)', (zoom, x, (1 << zoom) - 1 - y, buffer.getvalue()))
        db.commit()
        print('Rendered world zoom', zoom, flush=True)
    db.execute('VACUUM'); db.close()
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    target.with_suffix(target.suffix + '.sha256').write_text(digest + '  ' + target.name + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path('basemap/world.mbtiles'))
    args = parser.parse_args()
    build(args.source, args.output)
