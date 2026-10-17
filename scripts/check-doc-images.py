#!/usr/bin/env python3
"""Check local documentation images, including absolute Security-tab URLs."""
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
            prefix='/argentumseven/bungee/blob/main/'
            if url.netloc!='github.com' or not url.path.startswith(prefix):continue
            image=root/unquote(url.path.removeprefix(prefix))
        else:image=path.parent/unquote(url.path)
        if not image.is_file():raise SystemExit(f'Broken image: {name}: {target}')
        count+=1
print(f'PASS: {count} documentation image references resolve, including the Security-tab diagram.')
