from __future__ import annotations

import io
from typing import Any

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, UploadFile
from PIL import Image
from pydantic import BaseModel, Field

from app.config import Settings, get_settings
from app.keyboard.ngram_typer import generate_keystroke_timeline
from app.mouse.ghost_cursor import path_response
from app.vision import mock as vision_mock
from app.vision.openrouter_vision import get_engine

router = APIRouter(prefix="/v1")


def require_api_key(
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
    settings: Settings = Depends(get_settings),
) -> None:
    if x_api_key != settings.api_key:
        raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key")


class Point(BaseModel):
    x: float
    y: float


class Viewport(BaseModel):
    width: float = 1280
    height: float = 800


class MousePathRequest(BaseModel):
    start: Point
    end: Point
    viewport: Viewport | None = None
    overshoot_probability: float | None = Field(default=None, ge=0.0, le=1.0)


class KeyboardRequest(BaseModel):
    text: str
    locale: str = "en"


@router.get("/health")
def health(settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    engine = get_engine()
    # Clear stale "missing key" after user edits .env + restart; also allow soft re-check
    if not engine.ready:
        engine.error = None
        engine.ensure_client()
    return {
        "ok": True,
        "mock_vision": settings.mock_vision,
        "vision_provider": "mock" if settings.mock_vision else "openrouter",
        "vision_model": settings.openrouter_model,
        "vision_ready": engine.ready,
        "vision_error": engine.error,
        "openrouter_key_set": bool(settings.openrouter_api_key),
    }


@router.post("/mouse/path", dependencies=[Depends(require_api_key)])
def mouse_path(body: MousePathRequest) -> dict[str, Any]:
    return path_response(
        start=body.start.model_dump(),
        end=body.end.model_dump(),
        viewport=body.viewport.model_dump() if body.viewport else None,
        overshoot_probability=body.overshoot_probability,
    )


@router.post("/keyboard/timeline", dependencies=[Depends(require_api_key)])
def keyboard_timeline(body: KeyboardRequest) -> dict[str, Any]:
    return generate_keystroke_timeline(body.text, body.locale)


async def _read_image(file: UploadFile) -> Image.Image:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty image")
    return Image.open(io.BytesIO(data)).convert("RGB")


@router.post("/vision/locate", dependencies=[Depends(require_api_key)])
async def vision_locate(
    task: str = Form(...),
    image: UploadFile = File(...),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    img = await _read_image(image)
    if settings.mock_vision:
        return vision_mock.mock_locate(task, img.size)
    try:
        return get_engine().locate(img, task)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"OpenRouter locate failed: {exc}") from exc


@router.post("/vision/validate", dependencies=[Depends(require_api_key)])
async def vision_validate(
    expected_after: str = Form(...),
    image: UploadFile = File(...),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    img = await _read_image(image)
    if settings.mock_vision:
        return vision_mock.mock_validate(expected_after)
    try:
        return get_engine().validate(img, expected_after)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"OpenRouter validate failed: {exc}") from exc
