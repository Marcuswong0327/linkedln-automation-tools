# LinkedIn Automation Tools (Linktal internal)

- Vision: **Qwen2.5 VL 72B Instruct via OpenRouter** — screenshot → coordinates / UI state
- Mouse: Minimum-Jerk / Ghost-Cursor paths
- Typing: N-gram delay timeline (email gate)
- Execution: `chrome.debugger` only — no `element.click()`, no `web_accessible_resources`

Version 1.5 - Message Mode 
Version 2.0 - Profile view - 2000 profiles per day for Linkedln Sales Navigator

## Quick start

### Backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Check: http://127.0.0.1:8000/v1/health  


## Connect + Message flows

| Scenario | Behavior |
| --- | --- |
| **C1** Connect visible on bar | Click **Connect** |
| **C2** Follow / Message / **More (...)** only | Click **More** → click **Connect** in menu|
| **A2** Note modal | Click **Send without a note** |
| **A3** Email gate | Type soft-cap email → submit |
| **M1** Connected (blue Message) | Click **Message** → type template → **Send** |
| **Pending** Pending + blue Message | Skip / wait (`pending`) — no action |
| **Not connected** Connect + white Message | Message mode **auto-falls back** to Connect (C1/C2 → A2/A3) |

CTA fixtures (for vision grounding): `docs/fixtures/cta/`

## Hosting later (no GPU)

Deploy the same FastAPI to Azure/Hostinger

## Safety

- Daily / rolling connect caps in the extension
- Content-script watchdog for weekly limit / unusual activity / email gate
- Internal Linktal use only — respect LinkedIn limits and warm-up in the PRD
