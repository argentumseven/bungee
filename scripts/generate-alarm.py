#!/usr/bin/env python3
"""Reproduce a two-second browser preview and a bounded 30-second phone siren."""
from pathlib import Path
import io
import math
import struct
import wave

ROOT = Path(__file__).resolve().parents[1]
RATE = 22050
DURATION = 2

def wav_bytes(pcm):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(RATE)
        output.writeframes(pcm)
    return buffer.getvalue()

samples = bytearray()
for index in range(RATE * DURATION):
    seconds = index / RATE
    # 650 -> 1100 -> 650 Hz, with an integer number of phase cycles per cycle.
    phase = 2 * math.pi * (875 * seconds - 225 * DURATION / (2 * math.pi) * math.sin(2 * math.pi * seconds / DURATION))
    value = 0.6 * (0.85 * math.sin(phase) + 0.15 * math.sin(2 * phase))
    samples.extend(struct.pack("<h", round(32767 * value)))
for relative, pcm in (
    ("web/public/recovery-siren.wav", samples),
    ("android/app/src/main/res/raw/recovery_siren.wav", samples * 15),
):
    path = ROOT / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(wav_bytes(pcm))
