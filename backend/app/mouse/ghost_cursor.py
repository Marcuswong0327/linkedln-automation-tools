from __future__ import annotations

import math
import random
from typing import Any

# Simulate how human move - from slow to fast then slow again when approaching the target. 
def _min_jerk(t: float) -> float:
    """Minimum-jerk polynomial for t in [0, 1]."""
    return 10 * t**3 - 15 * t**4 + 6 * t**5

# Calculate time needed to move to the target based on button's size and distance from cursor. 
# farther / smaller button, takes longer time 
# duration range from 320ms to 1800ms. 
def _fitts_duration_ms(distance: float, target_width: float = 40.0) -> float:
    a, b = 250.0, 175.0
    d = max(distance, 1.0)
    w = max(target_width, 8.0)
    ms = a + b * math.log2(1.0 + d / w)
    return max(320.0, min(2000.0, ms))


def generate_ghost_cursor_path(
    start: dict[str, float],
    end: dict[str, float],
    viewport: dict[str, float] | None = None,
    overshoot_probability: float | None = None,  # None → random 0.10–0.25 per path
    dt_min_ms: float = 10.0,
    dt_max_ms: float = 25.0,
    rng: random.Random | None = None,
) -> list[dict[str, float]]:
    """Generate a human-like Minimum-Jerk / Bezier mouse path."""
    rng = rng or random.Random()
    x0, y0 = float(start["x"]), float(start["y"])
    x1, y1 = float(end["x"]), float(end["y"])
    vw = float((viewport or {}).get("width", 1280))
    vh = float((viewport or {}).get("height", 800))
    dt_min_ms = max(1.0, float(dt_min_ms)) # ensure minimum time is 1ms between points 
    dt_max_ms = max(dt_min_ms, float(dt_max_ms)) # ensure maximum time is greater than minimum time between points
    dt_avg = (dt_min_ms + dt_max_ms) / 2.0 # average time between points

    def next_dt() -> float:
        return rng.uniform(dt_min_ms, dt_max_ms) # random time between points

    dist = math.hypot(x1 - x0, y1 - y0)
    duration = _fitts_duration_ms(dist)  # Fitts' Law: time to reach target
    n = max(8, int(duration / dt_avg))

    # Control points with jitters (+-18% sideways wobble)
    mx, my = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    nx, ny = -(y1 - y0), (x1 - x0)
    norm = math.hypot(nx, ny) or 1.0
    nx, ny = nx / norm, ny / norm
    wobble = rng.uniform(-0.18, 0.18) * dist
    cx = mx + nx * wobble
    cy = my + ny * wobble

    def sample(u: float) -> tuple[float, float]:
        # Quadratic Bezier
        ox = (1 - u) ** 2 * x0 + 2 * (1 - u) * u * cx + u**2 * x1
        oy = (1 - u) ** 2 * y0 + 2 * (1 - u) * u * cy + u**2 * y1
        return ox, oy

    do_overshoot_p = (
        float(overshoot_probability)
        if overshoot_probability is not None
        else rng.uniform(0.10, 0.25)
    )
    do_overshoot = rng.random() < do_overshoot_p and dist > 40
    points: list[dict[str, float]] = []
    t_ms = 0.0  # initial time is 0ms 

    for i in range(n + 1):
        t = i / n
        u = _min_jerk(t)
        x, y = sample(u)
        jitter = rng.uniform(0.3, 0.7) # random jitter between 0.3 and 0.7
        x += rng.uniform(-jitter, jitter) # apply jitter to x and y coordinates
        y += rng.uniform(-jitter, jitter) # apply jitter to y coordinates
        x = max(0.0, min(vw - 1.0, x)) # ensure x is within viewport width
        y = max(0.0, min(vh - 1.0, y)) # ensure y is within viewport height
        points.append({"x": round(x, 2), "y": round(y, 2), "t_ms": round(t_ms, 1)}) # add point to list
        if i < n:
            t_ms += next_dt() # add time to next point

    if do_overshoot:
        angle = math.atan2(y1 - y0, x1 - x0)
        # Randomize how far past the button to overshoot the target
        delta_min = rng.uniform(5.0, 12.0)
        delta_max = rng.uniform(16.0, 28.0)
        if delta_max <= delta_min:
            delta_max = delta_min + 6.0
        delta = rng.uniform(delta_min, delta_max)
        ox = max(0.0, min(vw - 1.0, x1 + math.cos(angle) * delta))
        oy = max(0.0, min(vh - 1.0, y1 + math.sin(angle) * delta))
        # Corrective segment back to target (~180ms worth of variable steps)
        corr_n = max(4, int(180 / dt_avg))
        for i in range(1, corr_n + 1):
            t = i / corr_n
            u = _min_jerk(t)
            x = ox + (x1 - ox) * u
            y = oy + (y1 - oy) * u
            t_ms += next_dt()
            points.append(
                {
                    "x": round(max(0.0, min(vw - 1.0, x)), 2),
                    "y": round(max(0.0, min(vh - 1.0, y)), 2),
                    "t_ms": round(t_ms, 1),
                }
            )

    # Snap final point to target
    if points:
        points[-1]["x"] = round(x1, 2)
        points[-1]["y"] = round(y1, 2)
    return points


def path_response(
    start: dict[str, Any],
    end: dict[str, Any],
    viewport: dict[str, Any] | None = None,
    overshoot_probability: float | None = None,
) -> dict[str, Any]:
    return {
        "points": generate_ghost_cursor_path(
            start=start,
            end=end,
            viewport=viewport,
            overshoot_probability=overshoot_probability,
        )
    }
