from app.mouse.ghost_cursor import generate_ghost_cursor_path
from app.keyboard.ngram_typer import generate_keystroke_timeline


def test_path_ends_near_target():
    pts = generate_ghost_cursor_path({"x": 0, "y": 0}, {"x": 200, "y": 100}, overshoot_probability=0)
    assert pts[0]["t_ms"] == 0
    assert abs(pts[-1]["x"] - 200) < 1
    assert abs(pts[-1]["y"] - 100) < 1
    assert all(pts[i]["t_ms"] <= pts[i + 1]["t_ms"] for i in range(len(pts) - 1))


def test_keyboard_has_events():
    out = generate_keystroke_timeline("Hi@x.com")
    assert len(out["events"]) > 4
