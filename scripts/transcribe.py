#!/usr/bin/env python3
"""Transcribe one audio file with faster-whisper for the bili-lecture plugin.

Usage:
    python scripts/transcribe.py <audio.wav> <output-prefix> [model] [--threads N]

Writes <output-prefix>.json with {"language", "duration", "segments"} and
<output-prefix>.txt with timestamped lines. Audio must be 16 kHz mono WAV so the
script can read it with the standard library and avoid PyAV.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import wave
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("prefix")
    parser.add_argument("model", nargs="?", default="large-v3-turbo")
    parser.add_argument("--threads", type=int, default=0)
    parser.add_argument("--language", default="zh")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    audio_path = Path(args.audio)
    prefix = Path(args.prefix)
    prefix.parent.mkdir(parents=True, exist_ok=True)

    import numpy as np
    from faster_whisper import WhisperModel

    with wave.open(str(audio_path), "rb") as handle:
        if handle.getnchannels() != 1 or handle.getframerate() != 16000:
            raise SystemExit(f"expected 16 kHz mono WAV, got {handle.getframerate()} Hz {handle.getnchannels()} ch")
        frames = handle.readframes(handle.getnframes())
    audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0

    threads = args.threads or int(os.environ.get("WHISPER_THREADS", "0")) or (os.cpu_count() or 4)
    download_root = os.environ.get("WHISPER_DOWNLOAD_ROOT") or None
    if not download_root:
        local = Path.cwd() / ".models"
        if local.is_dir():
            download_root = str(local)
    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type="int8",
        cpu_threads=threads,
        download_root=download_root,
    )
    segments, info = model.transcribe(
        audio,
        language=args.language or None,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        beam_size=5,
        condition_on_previous_text=False,
    )

    rows = []
    for segment in segments:
        text = segment.text.strip()
        if not text:
            continue
        rows.append({"start": round(segment.start, 2), "end": round(segment.end, 2), "text": text})

    prefix.with_suffix(".json").write_text(
        json.dumps(
            {"language": info.language, "duration": info.duration, "segments": rows},
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )
    prefix.with_suffix(".txt").write_text(
        "\n".join(f"[{row['start']:.0f}s] {row['text']}" for row in rows),
        encoding="utf-8",
    )
    chars = sum(len(row["text"]) for row in rows)
    print(f"done: {len(rows)} segments, {chars} chars, lang={info.language}, dur={info.duration:.0f}s", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
