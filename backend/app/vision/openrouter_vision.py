from __future__ import annotations

import base64
import io
import json
import logging
import re
from typing import Any

from PIL import Image

from app.config import get_settings

logger = logging.getLogger(__name__)

# Prompt 
TASK_GOALS: dict[str, str] = {
    "connect": (
        "the button whose visible label is exactly Connect on the main profile action bar "
        "(same row as Message / Follow / More). Do NOT pick Message, Follow, or the three-dot More button. "
        "If Connect is NOT visible on that bar (only under More/...), return status not_found."
    ),
    "more_menu": (
        "the circular More button with three horizontal dots (...) on the profile action bar, "
        "usually to the right of Message or Connect"
    ),
    "connect_in_menu": (
        "the Connect row/item inside the already-open More overflow dropdown menu "
        "(person-plus icon + text Connect). Not Report/Block, not Send profile in a message."
    ),
    "send_without_a_note": 'the button labeled "Send without a note" on the invitation modal',
    "email_field": "the email address text input on the connect/email gate modal",
    "email_submit": "the primary submit/Continue/Send/Connect button on the email gate modal",
    "message": (
        "the FILLED PRIMARY Message button on the profile action bar: solid LinkedIn-blue background, "
        "white paper-plane icon + white text 'Message'. "
        "Do NOT pick the outlined/white-background Message button (that appears next to Connect for people "
        "you are NOT connected to). Not Messaging in the top nav, not More (...)."
    ),
    "message_box": (
        "the message composer text input where you type a LinkedIn DM. "
        "Either: (A) 'New message' modal — large textarea with placeholder 'Write a message...', "
        "or (B) existing chat thread — contenteditable/textarea at bottom with 'Write a message...'"
    ),
    "send": (
        "the Send control in the open LinkedIn messaging composer "
        "(Send button or paper-plane send icon next to the message box). Not Message on the profile bar."
    ),
    "profile_cta": (
        "Classify the profile action bar using Message button STYLE and labels (see triage rules). "
        "Return the correct profile_state and the primary click target for that state."
    ),
}

TRIAGE_PROMPT = """You are classifying the LinkedIn profile ACTION BAR (buttons under the name/headline).

CRITICAL — Message button visual styles (do not confuse them):
1) NOT CONNECTED: blue filled **Connect** (person+) AND outlined/WHITE-background **Message** (blue text/border, white fill). Often also More (...). Degree may show 2nd/3rd.
2) CONNECTED (1st): solid BLUE-background **Message** (white icon + white text) as the primary CTA. Usually NO Connect and NO Pending — often only Message + More (...). Degree shows · 1st.
3) PENDING invite: solid BLUE-background **Message** PLUS a white/outlined **Pending** button (clock icon + text Pending). Do nothing — wait to be accepted. Degree may still show 2nd.

Also:
- C2 overflow: Follow and/or Message and More (...), but Connect is ONLY inside More (no Connect on the bar).

Return ONLY valid JSON (no markdown):
{{
  "profile_state": "can_connect_direct" | "can_connect_overflow" | "can_message" | "pending" | "already_connected" | "unknown",
  "message_style": "filled_blue" | "outlined_white" | "absent" | "unknown",
  "targets": [{{"label": "Connect" | "More" | "Message" | "Pending", "x": <int>, "y": <int>, "confidence": <0-1>}}],
  "signals": ["short visible button labels + color notes, e.g. Connect blue, Message white outline, Pending"]
}}

Rules:
- can_connect_direct: Connect visible on bar (usually with outlined white Message) → targets[0] = Connect center. message_style=outlined_white.
- can_connect_overflow: no Connect on bar; More present (Connect under More) → targets[0] = More. Message if present is usually outlined_white.
- can_message / already_connected: CONNECTED — filled BLUE Message, no Connect, no Pending → targets[0] = Message center. message_style=filled_blue.
- pending: Pending button visible (with or without blue Message) → targets may include Pending; do NOT treat as can_message. message_style often filled_blue for Message.
- Prefer profile_state "pending" whenever Pending is visible, even if Message is blue.
- Prefer can_message over already_connected when filled blue Message is the actionable CTA.
Coordinates are pixel centers in THIS image (origin top-left). Image size is {width}x{height}.
"""


VALIDATE_PROMPT = """You are classifying a LinkedIn UI screenshot AFTER a Connect-related action.
Return ONLY valid JSON (no markdown) with this shape:
{{
  "state": "invite_sent" | "note_choice" | "email_gate" | "weekly_limit" | "captcha" | "unusual_activity" | "pending" | "already_connected" | "unknown",
  "signals": ["visible text clues"],
  "targets": [{{"label": "Send without a note", "x": 123, "y": 456, "confidence": 0.9}}],
  "raw_summary": "one short sentence"
}}

Rules:
- note_choice: modal titled like "Add a note to your invitation?" with "Add a note" and/or "Send without a note"
- email_gate: asks for the other person's email to connect
- weekly_limit: reached weekly invitation limit
- captcha / unusual_activity: bot checks, captcha, unusual activity
- pending: action bar shows Pending (clock) — often with blue Message; invitation waiting
- already_connected: 1st-degree — filled blue Message, no Connect/Pending
- invite_sent: invite appears sent with no blocking modal
- If note_choice, include the "Send without a note" button center in targets (CSS/screenshot pixels).
Coordinates are pixel centers in THIS image (origin top-left). Image size is {width}x{height}.
"""

MESSAGE_VALIDATE_PROMPT = """You are classifying a LinkedIn UI screenshot during Message (DM) automation.
Return ONLY valid JSON (no markdown):
{{
  "state": "composer_open" | "new_message_modal" | "thread_composer" | "message_sent" | "captcha" | "unusual_activity" | "unknown",
  "signals": ["visible text clues"],
  "targets": [{{"label": "message_box" | "Send", "x": <int>, "y": <int>, "confidence": <0-1>}}],
  "raw_summary": "one short sentence"
}}

Two composer layouts after clicking profile Message:
1) new_message_modal — centered dialog titled "New message", To: chip, "Write a message..." textarea, Send at bottom-right.
2) thread_composer — right-side or overlay chat thread with prior messages + "Write a message..." at bottom.

Rules:
- new_message_modal / thread_composer / composer_open: text input visible — include message_box center in targets; include Send if visible.
- message_sent: typed message visible in thread or modal closed with message delivered.
- captcha / unusual_activity: bot checks.
Coordinates are pixel centers in THIS image (origin top-left). Image size is {width}x{height}.
"""


class OpenRouterVisionEngine:
    
    #Vision LLM via OpenRouter (Qwen2.5 VL 72B Instruct).

    def __init__(self) -> None:
        self.client = None
        self.ready = False
        self.error: str | None = None
        self.model = "qwen/qwen2.5-vl-72b-instruct"

    # Ensure Qwen model is configured with API keyand ready to use
    def ensure_client(self) -> None:  
        if self.ready:
            return
        # Allow retry if key was missing and user added it
        settings = get_settings()
        self.model = settings.openrouter_model
        if not settings.openrouter_api_key:
            self.error = "OPENROUTER_API_KEY is missing in backend/.env"
            self.ready = False
            return
        try:
            from openai import OpenAI

            self.client = OpenAI(
                api_key=settings.openrouter_api_key,
                base_url=settings.openrouter_base_url,
                default_headers={
                    "HTTP-Referer": settings.openrouter_site_url,
                    "X-Title": settings.openrouter_app_name,
                },
            )
            self.ready = True
            self.error = None
            logger.info("OpenRouter vision ready model=%s", self.model)
        except Exception as exc: 
            self.error = str(exc)
            self.ready = False
            logger.exception("Failed to init OpenRouter Qwen Vision Model")

    def locate(self, image: Image.Image, task: str) -> dict[str, Any]:
        self.ensure_client()
        if not self.ready or self.client is None:
            raise RuntimeError(self.error or "OpenRouter vision not ready")

        w, h = image.size
        if task in ("profile_cta", "profile_cta_triage"):
            raw = self._call_vision(image, TRIAGE_PROMPT.format(width=w, height=h))
            data = self._parse_json(raw)
            targets = []
            for t in data.get("targets") or []:
                try:
                    targets.append(
                        {
                            "label": str(t.get("label") or ""),
                            "x": int(max(0, min(w - 1, float(t["x"])))),
                            "y": int(max(0, min(h - 1, float(t["y"])))),
                            "confidence": float(t.get("confidence") or 0.7),
                        }
                    )
                except Exception:  # noqa: BLE001
                    continue
            return {
                "profile_state": str(data.get("profile_state") or "unknown"),
                "message_style": str(data.get("message_style") or "unknown"),
                "targets": targets,
                "signals": list(data.get("signals") or []),
                "raw": raw[-400:],
                "provider": "openrouter",
            }

        goal = TASK_GOALS.get(task, f"the UI element for task '{task}'")
        prompt = f"""You are a GUI grounding assistant for LinkedIn automation.
Find {goal} in this screenshot.

Return ONLY valid JSON (no markdown):
{{
  "status": "found" | "not_found",
  "label": "short label",
  "x": <int center x>,
  "y": <int center y>,
  "confidence": <0-1 number>
}}

Coordinates are pixel centers in THIS image (origin top-left).
Image size is {w}x{h} pixels. x must be in [0,{w - 1}], y in [0,{h - 1}].
If the element is missing, status=not_found (still include a best-effort x,y if unsure).
"""
        raw = self._call_vision(image, prompt)
        data = self._parse_json(raw)
        x = int(max(0, min(w - 1, float(data.get("x", w // 2)))))
        y = int(max(0, min(h - 1, float(data.get("y", h // 2)))))
        label = str(data.get("label") or TASK_GOALS.get(task, task))
        status = str(data.get("status") or "found")
        confidence = float(data.get("confidence"))

        return {
            "status": status,
            "label": label,
            "x": x,
            "y": y,
            "confidence": confidence,
            "raw": raw[-400:],
            "provider": "openrouter",
        }

    def validate(self, image: Image.Image, expected_after: str) -> dict[str, Any]:
        self.ensure_client()
        # Guard clause 
        if not self.ready or self.client is None:
            raise RuntimeError(self.error or "OpenRouter vision not ready")

        w, h = image.size
        base = (
            MESSAGE_VALIDATE_PROMPT
            if str(expected_after).startswith("message_")
            else VALIDATE_PROMPT
        )
        prompt = base.format(width=w, height=h)
        prompt += f"\nContext: action just performed was '{expected_after}'."
        raw = self._call_vision(image, prompt)
        data = self._parse_json(raw)

        targets = []
        for t in data.get("targets") or []:
            try:
                targets.append(
                    {
                        "label": str(t.get("label") or ""),
                        "x": int(max(0, min(w - 1, float(t["x"])))),
                        "y": int(max(0, min(h - 1, float(t["y"])))),
                        "confidence": float(t.get("confidence") or 0.7),
                    }
                )
            except Exception:  # noqa: BLE001
                continue

        return {
            "state": str(data.get("state") or "unknown"),
            "signals": list(data.get("signals") or []),
            "targets": targets,
            "raw_summary": str(data.get("raw_summary") or raw[-200:]),
            "provider": "openrouter",
        }

    # call Vision model and return response in string format &g get AI content response
    def _call_vision(self, image: Image.Image, prompt: str) -> str:
        assert self.client is not None
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        b64 = base64.standard_b64encode(buf.getvalue()).decode("ascii") # convert image to base64 string from bytes
        data_url = f"data:image/png;base64,{b64}"

        # Call Qwen Vision Model 
        completion = self.client.chat.completions.create(
            model=self.model,
            max_tokens=1000,
            temperature=0,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt}, # parse down the prompt from top into the model 
                        {"type": "image_url", "image_url": {"url": data_url}}, # parse image URL in base64 string from bytes 
                    ],
                }
            ],
        )
        content = completion.choices[0].message.content
        if isinstance(content, list):
            parts = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(block.get("text", ""))
                else:
                    parts.append(str(block))
            return "\n".join(parts).strip()
        return str(content or "").strip()

    # convert JSON response from Qwen Vision Model to dictionary 
    @staticmethod
    def _parse_json(text: str) -> dict[str, Any]:
        text = text.strip()
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?\s*", "", text)
            text = re.sub(r"\s*```$", "", text)
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            match = re.search(r"\{[\s\S]*\}", text)
            if match:
                return json.loads(match.group(0))
            raise


_engine: OpenRouterVisionEngine | None = None


def get_engine() -> OpenRouterVisionEngine:
    global _engine
    if _engine is None:
        _engine = OpenRouterVisionEngine()
    return _engine
