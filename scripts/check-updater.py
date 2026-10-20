#!/usr/bin/env python3
"""Verify cold encrypted snapshots and transaction recovery without formatting disks.

The kernel LUKS mount and systemd boot path require a real deployment host. The
archive tests run real tar/age pipelines; transaction tests inject failing engines.
"""
from pathlib import Path
import subprocess
import sys
subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py', '-v'], cwd=Path(__file__).resolve().parents[1], check=True)
