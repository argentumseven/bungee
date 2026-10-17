#!/usr/bin/env python3
"""Check local image assets and immutable repository image references."""
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote, urlparse

root=Path(__file__).resolve().parents[1]
files=subprocess.check_output(['rg','--files','-g','*.md','-g','!work/**'],cwd=root,text=True).splitlines()
count=pinned=0
for name in files:
    path=root/name
    content=path.read_text()
    targets=re.findall(r'!\[[^\]]*\]\(([^\s)]+)',content)+re.findall(r'<img\b[^>]*\bsrc=[\"\']([^\"\']+)',content)
    for target in targets:
        url=urlparse(target)
        revision=None
        if url.scheme:
            prefix='/argentumseven/bungee/blob/'
            if url.netloc!='github.com' or not url.path.startswith('/argentumseven/bungee/'):
                continue
            if not url.path.startswith(prefix):
                raise SystemExit(f'Use a pinned repository blob image: {name}: {target}')
            revision,separator,asset=unquote(url.path.removeprefix(prefix)).partition('/')
            if not separator or not re.fullmatch(r'[a-f0-9]{40}',revision):
                raise SystemExit(f'Image must name the commit containing it, not a branch: {name}: {target}')
            image=root/asset
            pinned+=1
        else:
            image=path.parent/unquote(url.path)
        if not image.is_file():
            raise SystemExit(f'Broken image: {name}: {target}')
        if revision:
            # A shallow CI checkout may omit the ancestor. Never fetch implicitly.
            known=subprocess.run(['git','cat-file','-e',revision+'^{commit}'],cwd=root,stderr=subprocess.DEVNULL).returncode==0
            if known:
                expected=subprocess.run(['git','rev-parse','--verify',revision+':'+asset],cwd=root,capture_output=True,text=True)
                actual=subprocess.check_output(['git','hash-object',str(image)],cwd=root,text=True).strip()
                if expected.returncode or expected.stdout.strip()!=actual:
                    raise SystemExit(f'Pinned image content does not match: {name}: {target}')
        count+=1
print(f'PASS: {count} embedded image assets exist; {pinned} repository images use immutable commit URLs.')
