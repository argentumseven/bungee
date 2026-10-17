#!/usr/bin/env python3
"""Check embedded documentation images without assuming another Git ref exists."""
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote, urlparse
root=Path(__file__).resolve().parents[1]
files=subprocess.check_output(['rg','--files','-g','*.md','-g','!work/**'],cwd=root,text=True).splitlines()
count=0
for name in files:
    path=root/name
    content = path.read_text()
    targets = re.findall(r'!\[[^\]]*\]\(([^\s)]+)', content) + re.findall(r'<img\b[^>]*\bsrc=[\"\']([^\"\']+)', content)
    for target in targets:
        url=urlparse(target)
        if url.scheme:
            if url.netloc == 'github.com' and url.path.startswith('/argentumseven/bungee/'):
                raise SystemExit(f'Cross-revision image in {name}: use a relative image or an inline diagram instead of {target}')
            continue
        else:image=path.parent/unquote(url.path)
        if not image.is_file():raise SystemExit(f'Broken image: {name}: {target}')
        count+=1
print(f'PASS: {count} embedded local images resolve; no repository images are pinned to another branch.')
