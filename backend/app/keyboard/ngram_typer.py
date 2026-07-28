from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Any

DATA_PATH = Path(__file__).resolve().parents[2] / "data" / "ngram_delays.json"

# Minimal fallback digraph means (ms) if JSON missing
_FALLBACK_BASE = 85.0


def _load_table() -> dict[str, float]:
    if DATA_PATH.exists():
        raw = json.loads(DATA_PATH.read_text(encoding="utf-8"))
        return {str(k): float(v) for k, v in raw.items()}
    return {}


_TABLE = _load_table()


def _delay_for(prev: str, curr: str, rng: random.Random) -> float:
    # randomness delay between keystrokes, jitters, capital letter, punctuation 
    key = f"{prev.lower()}{curr.lower()}"
    mean = _TABLE.get(key, _FALLBACK_BASE)
    jitter = rng.uniform(-0.15, 0.15)
    delay = mean * (1.0 + jitter)
    if curr.isupper() or (prev and prev.isupper()):
        delay *= 1.12
    if curr in ".!?;:,":
        delay += rng.uniform(300.0, 500.0)
    return max(35.0, delay)


def _key_code(ch: str) -> tuple[str, str, bool]:
    """Return (key, code, needs_shift)."""
    if ch in ("\n", "\r"):
        return "Enter", "Enter", False
    if ch == " ":
        return " ", "Space", False
    if ch == "@":
        return "@", "Digit2", True
    if ch == ".":
        return ".", "Period", False
    if ch == ",":
        return ",", "Comma", False
    if ch == "-":
        return "-", "Minus", False
    if ch == "_":
        return "_", "Minus", True
    if ch.isalpha():
        upper = ch.isupper()
        return ch, f"Key{ch.upper()}", upper
    if ch.isdigit():
        return ch, f"Digit{ch}", False
    return ch, f"Key{ch.upper()}" if ch.isalpha() else "Unidentified", False


def generate_keystroke_timeline(text: str, locale: str = "en") -> dict[str, Any]:
    del locale  # reserved
    rng = random.Random()
    events: list[dict[str, Any]] = []
    prev = ""
    first = True
    for ch in text:
        if ch == "\r":
            continue
        delay = 0.0 if first else _delay_for(prev, ch if ch != "\n" else ".", rng)
        if ch == "\n":
            delay += rng.uniform(180.0, 420.0)
        first = False
        key, code, shift = _key_code(ch)
        text_payload = "\n" if ch == "\n" else ch
        if shift:
            events.append({"op": "keyDown", "key": "Shift", "code": "ShiftLeft", "delay_ms": round(delay, 1)})
            events.append(
                {
                    "op": "keyDown",
                    "key": key,
                    "code": code,
                    "text": text_payload,
                    "delay_ms": round(rng.uniform(20, 45), 1),
                }
            )
            events.append({"op": "keyUp", "key": key, "code": code, "delay_ms": round(rng.uniform(30, 70), 1)})
            events.append({"op": "keyUp", "key": "Shift", "code": "ShiftLeft", "delay_ms": round(rng.uniform(15, 40), 1)})
        else:
            events.append(
                {
                    "op": "keyDown",
                    "key": key,
                    "code": code,
                    "text": text_payload,
                    "delay_ms": round(delay, 1),
                }
            )
            events.append({"op": "keyUp", "key": key, "code": code, "delay_ms": round(rng.uniform(30, 70), 1)})
        prev = ch
    return {"events": events}
