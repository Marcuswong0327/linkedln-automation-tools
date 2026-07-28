# Product Requirements Document (PRD)
# LinkedIn Connection Automation Stack

**Product:** LinkedIn Automation Tools (internal / Linktal colleagues only)  
**Version:** 1.3 (PRD) — Product roadmap: **V1 / V2 = Connect + Message only; V3 = Profile View**  
**Date:** 2026-07-27  
**Status:** Draft — Ready for Version 1 implementation  
**Owners:** Internal DIY tooling team

---

## 1. Executive Summary

Build a **dumb-client / smart-brain** LinkedIn automation system that:

1. Accepts a list of LinkedIn profile URLs.
2. Opens (or reuses) a **non-focused Chrome window** behind the user’s active work so automation continues without blocking the user’s mouse/keyboard.
3. Uses **vision (VLM)** to locate UI targets (Connect, More/⋯, Message, Send, email field) from screenshots — not brittle DOM selectors.
4. Moves the cursor and types with **human-like biometrics** (Minimum-Jerk / Ghost-Cursor paths + N-gram keystroke delays).
5. Executes all input via **`chrome.debugger`** (`Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`), never `element.click()` or `input.value = …`.
6. Enforces **LinkedIn-safe pacing** (daily/rolling weekly caps, warm-up, soft/hard cap detection, sent-invite cleanup, **profile-view caps in V3**).
7. Stays **undetectable via WAR scans**: Manifest V3 must **never** declare `web_accessible_resources` (see §12.1).

### Product version roadmap (normative)

| Product version | Scope | Not in this version |
| --- | --- | --- |
| **V1** | Connect mode + Message mode + mouse/typing biometrics + background worker + policy basics | Profile View mode; GAN/RNN |
| **V2** | Still **Connect + Message only** — biometric upgrades (GAN/RNN), hygiene jobs, richer validators, ops hardening | Profile View mode |
| **V3** | **Profile View mode** — visit profiles so the operator appears in “Who viewed your profile,” without Connect/Message | — |

**V1 ship target:** mouse + typing + Connect/Message in a background worker window.

- **Connect mode** — Connect (direct or ⋯) → `invite sent` | `Send without a note` | email gate.
- **Message mode** — already connected → **Message** → type → send.

**V3 (later):** dedicated **View** job that only opens/scrolls/reads profiles to generate profile-view notifications — no Connect, no Message.
---

## 2. Problem Statement

Manual LinkedIn outreach does not scale. Classic bots that use DOM selectors and instant clicks/typing are:

- Fragile when LinkedIn A/B-tests UI.
- Easy for LinkedIn’s anti-abuse systems to detect via unnatural telemetry (teleporting cursor, constant typing intervals, instant scrolls).
- Unsafe without strict rolling-window rate limits and modal detection.

We need a **vision-driven, biometrically plausible, rate-limited** pipeline that can process a queue of profile URLs in a background Chrome window while the operator continues normal work in another window.

---

## 3. Goals & Non-Goals

### 3.1 Goals

| ID | Goal |
| --- | --- |
| G1 | **V1/V2:** Process URLs in **Connect** and/or **Message** modes (see §8.2–8.3). |
| G1b | **V3 only:** Process URLs in **View** mode so targets may see the operator under “Who viewed your profile” (§5.4.5, §8.6). |
| G2 | Run automation in a **separate Chrome window** with `focused: false` so the user can keep working elsewhere. |
| G3 | Locate interactive targets via **screenshot + VLM coordinates** (GoClick or equivalent). |
| G4 | Generate **Minimum-Jerk / Ghost-Cursor** mouse paths and play them back via `chrome.debugger`. |
| G5 | Type messages / email with **N-gram statistical delays** (JSON dictionary), not fixed random intervals. |
| G6 | Enforce LinkedIn policy constraints: daily 15–20 connects (warm-up lower), rolling 7-day soft ceiling ~80–90, hard weekly ~100. |
| G6b | **V3:** Enforce daily **profile view** caps (free ≈150/day; Sales Nav / Recruiter Lite configurable up to ≈2000). Count **all** profile navigations (Connect/Message/View) toward the view budget. |
| G7 | Detect soft/hard caps, CAPTCHA, unusual-activity UI; pause automation for mandated cooldowns. |
| G8 | Log every connect / message / (**V3**) view action with timestamps for rolling-window accounting. |
| G9 | Weekly job: withdraw Sent Invitations older than 3 weeks (**V2**). |
| G10 | Prevent LinkedIn **web-accessible-resource fingerprinting** by omitting `web_accessible_resources` entirely. |

### 3.2 Non-Goals

| ID | Non-Goal |
| --- | --- |
| NG1 | Training or hosting a production GAN mouse model (**V2+**; V1 uses mathematical Minimum-Jerk / Bezier). |
| NG2 | Training an RNN on Clarkson (or similar) datasets in V1 (V1 ships precomputed N-gram JSON; RNN in V2). |
| NG3 | Multi-account farm / SaaS for third parties (internal colleagues only). |
| NG4 | Full feed engagement automation (likes/comments) beyond warm-up guidance. |
| NG5 | Bypassing CAPTCHAs or LinkedIn security challenges — **detect and stop only**. |
| NG6 | Minimizing/hiding the Chrome yellow “debugger attached” banner (unavoidable; document only). |
| NG7 | V1 **does not** send a connection note — prefer **Send without a note** (1st-degree messaging is Message mode). |
| NG8 | **V1 and V2 do not ship Profile View mode.** Visiting a profile during Connect/Message may still register a view as a *side effect*, but there is no View-only job until **V3**. |

---

## 4. Users & Use Cases

### 4.1 Primary User

Internal operator (Linktal colleague) who:

- Is already logged into LinkedIn in Chrome.
- Has a CSV/list of profile URLs and a message template.
- Needs the queue to run in a background window while they work in another window/monitor.

### 4.2 Primary Use Cases

1. **Batch connect (no note) — V1:** Paste N URLs → Connect mode → connection request via **Send without a note** (or success with no modal).
2. **Batch message (already connected) — V1:** Paste N URLs → Message mode → click **Message** → type template → send.
3. **Background operation — V1:** Automation window stays open (not minimized), unfocused; user works elsewhere.
4. **Safety stop — V1:** Hard weekly limit / CAPTCHA / unusual-activity → immediate kill + cooldown.
5. **Hygiene — V2:** Weekly withdraw of stale sent invitations (>3 weeks).
6. **Soft-touch profile views — V3:** Paste N URLs → **View** mode → open each profile, scroll/read naturally, **do not** Connect or Message → appear in target’s “Who viewed your profile.”
---

## 5. Critical UX Constraint: Background Window Rendering

### 5.1 Problem

Vision depends on `chrome.tabs.captureVisibleTab`. If the automation window is **minimized**, Chrome may pause rendering → blank/frozen screenshots → VLM failure.

### 5.2 Required Behavior

| Behavior | Requirement |
| --- | --- |
| Open automation window | `chrome.windows.create({ url, focused: false, type: "normal" })` |
| Focus | Never steal focus during the run (`focused: false` on create; avoid `windows.update(..., { focused: true })`). |
| Minimized | **Forbidden** while a job is running. If user minimizes, pause job and show a clear UI warning. |
| Occlusion | Window may sit behind other windows; that is OK as long as it is not minimized. |
| User work | User continues in another Chrome window / other apps; debugger events target the automation tab only (do not move OS cursor). |
| Debugger banner | Yellow “Background page is debugging this browser” banner is expected; document that LinkedIn cannot see it (outside page DOM). |

### 5.3 Multi-URL Flow (Happy Path)

```
User pastes URLs + chooses job mode (Connect | Message) + templates in Side Panel
        │
        ▼
Extension creates/reuses Worker Window (focused: false)
        │
        ▼
For each URL (while under daily + rolling caps):
  Navigate tab → wait load → Gaussian think-time
  Optional chunked scroll (read simulation)
  Screenshot → Brain classifies profile CTA state
        │
        ├─ CONNECT MODE
        │    Locate Connect (direct) OR More/⋯ then Connect
        │    Click Connect → validate post-connect UI:
        │      • invite_sent / success → LOG connect_sent
        │      • send_without_a_note UI → click "Send without a note" → LOG
        │      • email_gate → type softCapEmail → submit → LOG email_gate_filled
        │      • weekly_limit / captcha / unusual → SAFETY PAUSE
        │
        └─ MESSAGE MODE (1st-degree / already connected)
             Locate Message → click → locate composer
             Type messageTemplate via Fingers → click Send → LOG message_sent
  Gaussian inter-profile delay
        │
        ▼
Queue complete or safety pause
```

---

## 5.4 Profile Action Scenarios (Normative)

These are the **canonical UI branches** Phase 1 must implement. Vision returns labels/coordinates; the Hand never hardcodes CSS selectors for these buttons.

### 5.4.1 Connect — finding the button

| Scenario | Detection | Action sequence |
| --- | --- | --- |
| **C1 — Connect visible** | VLM status `found`, label ≈ `Connect` on the profile action bar | Move + click **Connect** |
| **C2 — Connect under More (⋯)** | VLM status `connect_in_overflow` (or `found` on More/⋯ only) | Move + click **More / ⋯** → wait menu → locate **Connect** in menu → move + click **Connect** |

If neither Connect nor a More menu that contains Connect is found after scroll retries → outcome `needs_review` (or `pending` / `already_connected` / `message_available` if those CTAs are what vision sees).

### 5.4.2 Connect — after clicking Connect

| Scenario | Detection | Action sequence | Outcome |
| --- | --- | --- | --- |
| **A1 — Success (no modal / invite sent)** | Validate: `invite_sent` or toast/UI shows pending invite; Connect becomes Pending | Log success; next URL | `connect_sent` |
| **A2 — Note choice modal** | Validate: `note_choice` — UI offers **Add a note** and/or **Send without a note** / Send without note | **Click “Send without a note”** (Phase 1 default — do **not** open the note composer in Connect mode) | `connect_sent` |
| **A3 — Email gate** | Validate: `email_gate` — modal asks for recipient’s email to connect | Locate email field → type configured **`softCapEmail`** (default `marcus.wong@linktal.com.au`) via Fingers → locate confirm/Connect/Submit → click | `email_gate_filled` |
| **A4 — Hard weekly limit** | Validate: `weekly_limit` | Abort job; cooldown 72–96h | `hard_cap` |
| **A5 — CAPTCHA / unusual activity** | Validate: `captcha` / `unusual_activity` | Abort job; cooldown ≥5 days | `emergency_stop` |

**Policy note on A3:** Filling the email unblocks that single invite for testing. Still **log** every `email_gate` hit. Configurable `pauseAfterEmailGate` (default **false** in Phase 1 dogfood; recommend **true** / 48h pause in steady-state ops) because email gates are a LinkedIn trust signal.

### 5.4.3 Message — already connected

| Scenario | Detection | Action sequence | Outcome |
| --- | --- | --- | --- |
| **M1 — Message visible** | Profile shows **Message** (1st-degree) | Click **Message** → wait composer → locate text box → type `messageTemplate` (N-gram delays) → locate **Send** → click | `message_sent` |
| **M2 — Not connected yet** | Message mode but only Connect/Pending visible | Skip with `not_connected` (do not auto-switch to Connect unless job mode is `auto`) | `not_connected` |

### 5.4.4 Job modes

| Mode | Product version | Behavior |
| --- | --- | --- |
| `connect` | V1+ | Only §5.4.1–5.4.2. If profile already shows Message / Pending / Connected, skip with that outcome. |
| `message` | V1+ | Only §5.4.3. Requires Message CTA. |
| `auto` | V1 optional | If Message visible → Message flow; else if Connect (direct or overflow) → Connect flow. **Never** View-only. |
| `view` | **V3 only** | Only §5.4.5. Navigate + human-like browse. **Never** click Connect, Message, Follow, or Send. |

### 5.4.5 Profile View mode — “Who viewed your profile” (V3 only)

**Intent:** Soft-touch awareness. Opening someone’s profile (while logged in, not in private mode) typically notifies them that you viewed their profile. This is **not** the same as LinkedIn Premium “Open Profile” messaging.

| Scenario | Detection | Action sequence | Outcome |
| --- | --- | --- | --- |
| **V1 — Profile loaded** | Page shows a normal profile hero / About | Gaussian “read” delay; optional chunked scroll through About / Experience (200–400 px, 1–3 s pauses); optional small mouse wander (Arm) — **no CTA clicks** | `profile_viewed` |
| **V2 — Authwall / unavailable** | Login wall, profile not found, restricted | Skip | `view_blocked` |
| **V3 — Safety UI** | CAPTCHA / unusual activity | Abort + ≥5 day cooldown | `emergency_stop` |

**Hard rules for `view` mode:**

1. Do **not** click Connect, More→Connect, Message, Follow, or any invite/message control.
2. Every successful navigation counts as **1 profile view** against the daily view budget (shared with Connect/Message navigations — see G6b).
3. Spread views across the day (Gaussian gaps); avoid dumping 100+ views in a short burst.
4. Default daily view soft cap for free accounts: **≤120** (buffer under LinkedIn’s ~150 free-account guideline). Sales Nav / Recruiter Lite: configurable, default soft cap **≤800** (buffer under ~2000).
5. Private/incognito browsing mode is **out of scope** — View mode requires a normal logged-in session so the view is attributable (otherwise the feature is pointless).

**V1/V2 clarification:** Connect and Message jobs already navigate to profile URLs, so they may create “viewed your profile” events as a **side effect**. That does **not** satisfy V3. V3 is an explicit View-only queue with view budgeting and no outreach clicks.---

## 5.5 Confirmed LinkedIn UI Fixtures (from real screenshots)

Stored under `docs/fixtures/connect/`. Vision prompts and integration tests must match this **exact UI copy**.

| Scenario | Fixture file | What vision must see | Hand action |
| --- | --- | --- | --- |
| **C1** — Connect on action bar | `C1_connect_visible.png` | Primary blue **Connect** button (person+ icon) next to Message / More | Click **Connect** |
| **C2** — Connect under More | `C2_more_menu_connect.png` | Action bar may show Follow / Message / Visit my website / **More (...)**; after More opens, menu item **Connect** (person+ icon), often with banner “Connect if you know each other.” | Click **More (...)** → click **Connect** in menu |
| **A2** — Note choice modal | `A2_send_without_a_note_modal.png` | Modal title **“Add a note to your invitation?”**; buttons **Add a note** (secondary) and **Send without a note** (primary blue) | Click **Send without a note** (never **Add a note** in V1 Connect mode) |
| **A3** — Email gate | *(fixture TBD — operator confirmed scenario exists)* | Modal asking for recipient email to connect | Type `softCapEmail` → submit |

**Copy rule:** LinkedIn’s no-note CTA is **“Send without a note”**. 

**C2 note:** Presence of **Follow** and/or **Message** on a 2nd-degree profile does **not** mean Connect is unavailable — Connect is frequently nested under **More (...)**. CTA triage must check the overflow menu before classifying as `cannot_connect`.

---

## 6. System Architecture

### 6.1 High-Level Diagram

```
┌─────────────────────────────────────────────────────────────┐
│  Chrome Extension (The Hand) — dumb client                  │
│  • Popup / Side Panel (queue UI)                            │
│  • Background Service Worker                                │
│  • Worker Window + Tab (focused: false)                     │
│  • chrome.tabs.captureVisibleTab                            │
│  • chrome.debugger Input.dispatch*                          │
│  • chrome.storage.local / IndexedDB (rate logs, cooldowns)  │
│  • Content script: modal / CAPTCHA text watchdogs           │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTPS JSON
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  FastAPI on Google Cloud Run (The Brain / Arm / Fingers)    │
│  • /v1/vision/locate     — VLM (Qwen Vision Model)          │
│  • /v1/vision/validate   — post-action state check          │
│  • /v1/mouse/path        — Minimum-Jerk / Ghost-Cursor      │
│  • /v1/keyboard/timeline — N-gram delay dictionary ±15%     │
│  • /v1/health                                               │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 Component Responsibilities

| Component | Nickname | Responsibility |
| --- | --- | --- |
| VLM service | **Brain** | From screenshot + prompt → return `{x, y}` or structured UI state. |
| Mouse path generator | **Arm** | From `(x0,y0)` → `(x1,y1)` → array of `{x,y,t}` with Minimum-Jerk easing, optional overshoot. |
| Keystroke planner | **Fingers** | From message string → array of `{type, key, code, delayMs}` using N-gram JSON. |
| Chrome extension | **Hand** | Screenshot, API calls, play back events via debugger, enforce local policy DB. |

### 6.3 Why Not Run Models in the Extension

Running VLMs/GANs in the extension background would exhaust memory and trip performance warnings. Phase 1 and beyond keep ML/math on Cloud Run; the extension only plays back deterministic timelines.

---

## 7. Phased Delivery (Product Versions)

### Version 1 — MVP — **Connect + Message only**

**In scope:**

- Extension Manifest V3: popup/side panel, service worker, content watchdog, debugger playback.
- **Hard rule:** no `web_accessible_resources` in `manifest.json` (§12.1).
- Worker window multi-URL queue (`focused: false`).
- Cloud Run FastAPI skeleton with:
  - Vision locate + validate (GoClick or GPT-4o Vision fallback).
  - `generate_ghost_cursor_path` (Minimum-Jerk / Fitts-inspired duration + Bezier/Ghost-Cursor style points).
  - Keystroke timeline from **static N-gram JSON** (±15% variance, punctuation pauses 300–500 ms).
- **Connect flow:** C1 direct Connect / C2 More→Connect → A1 success / A2 Send without a note / A3 email fill.
- **Message flow:** M1 Message → type → Send (already connected).
- Job modes UI: `connect` | `message` | `auto` only — **no `view`**.
- Local rate-limit DB (rolling 168h connects), daily connect cap, Gaussian inter-action delays.
- Hard-cap + unusual-activity detectors → pause; email-gate fill + optional pause flag.
- Natural chunked scrolling if Connect/Message target not in viewport.

**Out of scope for V1:** Profile View mode, GAN/RNN, Connect-with-note, Sent-Invites withdrawer, acceptance-rate scraper.

### Version 2 — Still **Connect + Message only** (harden & upgrade)

- Weekly Sent Invitations withdraw (>3 weeks).
- Weekly connections scrape → acceptance rate; if 10–15% or UI warning → 2-day pause.
- Steady-state: enable `pauseAfterEmailGate` (48h); hard weekly limit → 3–4 day deep sleep.
- Optional GAN mouse path endpoint; optional RNN/Markov keystroke model.
- Optional Connect-with-note path (Add a note) as a separate job option.
- Richer planner-actor-validator loop; Cloud Run auth/observability; config UI polish.
- **Still no dedicated Profile View mode.**

### Version 3 — **Profile View mode** (“Who viewed your profile”)

- New job mode: `view` (§5.4.5, §8.6, §10.3).
- Side Panel: View mode selector + daily view budget meter.
- Shared **profile view counter** across all modes (every profile navigation increments it).
- Free-account default soft cap ≤120 views/day; Sales Nav / Recruiter Lite configurable (default soft ≤800).
- Human-like browse: load → Gaussian dwell → chunked scroll / light mouse wander → next URL.
- **Forbidden in View mode:** Connect, Message, Follow, invite/email flows.
- Safety: CAPTCHA / unusual activity → same emergency stop as V1.
- Optional later: schedule View jobs in the morning and Connect jobs in the afternoon to space telemetry.
---

## 8. Functional Requirements

### 8.1 Queue & Job Control

| ID | Requirement | Priority |
| --- | --- | --- |
| F1 | User can paste or upload a list of LinkedIn profile URLs (`https://www.linkedin.com/in/...`). Invalid URLs are flagged and skipped. | P0 |
| F2 | User can set a **message template** (plain text) used in **Message mode**. Optional `{firstName}` later; Phase 1 template-only OK. | P0 |
| F2b | User can set **`softCapEmail`** (default `marcus.wong@linktal.com.au`) used when Connect flow hits the email gate. | P0 |
| F2c | User selects job mode: `connect` \| `message` \| `auto`. (**V3** adds `view`.) | P0 |
| F3 | User can Start / Pause / Resume / Abort a job. | P0 |
| F4 | Job runs in a dedicated worker window created with `focused: false`. | P0 |
| F5 | If worker window is minimized or closed, job auto-pauses and UI explains why. | P0 |
| F6 | Progress UI shows: current URL, index N/M, last action, remaining daily/rolling quota. | P0 |
| F7 | Per-URL outcome: `connect_sent` \| `email_gate_filled` \| `pending` \| `already_connected` \| `message_sent` \| `not_connected` \| `hard_cap` \| `needs_review` \| `error`. | P0 |

### 8.2 Connect Flow

| ID | Requirement | Priority |
| --- | --- | --- |
| F10 | Navigate to profile URL; wait for load + Gaussian “read” delay. | P0 |
| F11 | Screenshot → Brain locates primary CTA. Prefer direct **Connect** (scenario C1). | P0 |
| F11b | If Connect is not on the action bar but **More / ⋯** is, open overflow and locate **Connect** inside (scenario C2). | P0 |
| F12 | If target not visible, chunked scroll (200–400 px, 1–3 s pauses), re-screenshot, retry (max N scrolls). | P0 |
| F13 | Arm returns path; Hand dispatches move events then `mousePressed`/`mouseReleased` at target. | P0 |
| F14 | After Connect click, validate UI into A1–A5 (§5.4.2). | P0 |
| F15 | On note-choice modal (**A2**): click **Send without a note** (not Add a note). | P0 |
| F16 | On email gate (**A3**): type `softCapEmail` with Fingers timeline, submit/confirm via vision-located control. | P0 |
| F16b | If `pauseAfterEmailGate` is true, after a successful email fill enter 48h cooldown; Phase 1 dogfood default = false. | P1 |
| F17 | On A1/A2/A3 success paths, append `{url, ts, outcome}` to local store; count toward connect quotas. | P0 |
| F18 | If profile already shows Pending / Connected / Message while in `connect` mode, skip without clicking (outcome `pending` / `already_connected`). | P0 |

### 8.3 Message Flow (Already Connected)

| ID | Requirement | Priority |
| --- | --- | --- |
| F40 | In `message` (or `auto` when Message CTA present): locate **Message** on profile action bar. | P0 |
| F41 | Click Message → validate messaging overlay/thread composer is open. | P0 |
| F42 | Locate message input; type `messageTemplate` via Fingers (N-gram delays, punctuation pauses). | P0 |
| F43 | Locate **Send**; click via Arm/Hand; validate sent / message appears in thread. | P0 |
| F44 | Log `message_sent` with timestamp. Message sends may use a separate daily soft cap (configurable; default same working-hours gating; do not count as connection invites). | P0 |
| F45 | If Message CTA absent (not connected), outcome `not_connected` — do not attempt Connect unless mode is `auto`. | P0 |

### 8.4 Safety & Policy

| ID | Requirement | Priority |
| --- | --- | --- |
| F20 | Before each **connect**, count connect events in last **168 hours**; if count ≥ soft ceiling (default **85**, range 80–90), pause until oldest ages out. | P0 |
| F21 | Enforce daily **connect** cap (default **15**, warm-up 5–20; UI max 25). Never exceed **100** connects in rolling week. | P0 |
| F22 | Only schedule actions during **working hours** (configurable, default Mon–Fri 09:00–18:00 local). | P1 |
| F23 | Email gate: **fill** `softCapEmail` (see F16). Optionally pause 48h if `pauseAfterEmailGate`. | P0 |
| F24 | Hard cap: “You've reached the weekly invitation limit” → deep sleep **72–96 hours**. | P0 |
| F25 | CAPTCHA / unusual activity / verification prompt → kill job, cooldown **≥5 days**. | P0 |
| F26 | Acceptance rate ≤10–15% (V2) or explicit UI warning → pause **2 days**. | P1 |
| F27 | Warm-up presets: Day 8–14 cap 5–10/day; Day 15–21 ramp +3–5 every other day toward target ≤20. | P1 |

### 8.5 Hygiene Jobs (V2)

| ID | Requirement | Priority |
| --- | --- | --- |
| F30 | Weekly navigate to Sent Invitations; withdraw invites older than **21 days**. | P1 |
| F31 | Weekly scrape connections vs sent to compute acceptance ratio; store history. | P1 |

### 8.6 Profile View Mode (V3 only)

| ID | Requirement | Priority |
| --- | --- | --- |
| F50 | Job mode `view` available in Side Panel (hidden/disabled until V3 ships). | P0 (V3) |
| F51 | For each URL: navigate → wait load → Gaussian dwell (e.g. μ≈20–45s) → optional chunked scroll + light mouse wander → log `profile_viewed` → Gaussian gap → next. | P0 (V3) |
| F52 | **Never** dispatch clicks on Connect, More→Connect, Message, Follow, or Send while `mode === "view"`. | P0 (V3) |
| F53 | Maintain `profileViewEvents[]` with timestamps; before each profile navigation in **any** mode, if today’s view count ≥ `dailyViewCap`, pause View jobs and warn Connect/Message operators. | P0 (V3) |
| F54 | Defaults: `accountTier: "free"` → `dailyViewCap: 120`; `"sales_nav"` / `"recruiter_lite"` → `dailyViewCap: 800` (configurable). | P0 (V3) |
| F55 | Spread views across working hours; reject “burst” schedules that would dump the daily cap in &lt;30 minutes. | P1 (V3) |
| F56 | Outcomes: `profile_viewed` \| `view_blocked` \| `needs_review` \| `error` \| `emergency_stop`. | P0 (V3) |
| F57 | UI copy explains: View mode is for appearing in “Who viewed your profile”; it is not Open Profile messaging and does not send invites. | P1 (V3) |
---

## 9. Behavioral Simulation Requirements (Technical Telemetry)

LinkedIn observes **how** you interact, not only **what** you do. Phase 1 must satisfy:

| Action | Forbidden (bot) | Required (stealth) |
| --- | --- | --- |
| Clicks | `element.click()` | Debugger `Input.dispatchMouseEvent` at coordinates along a path |
| Mouse path | Instant teleport | Minimum-Jerk / Ghost-Cursor points; start slow → accelerate → decelerate; ~10% slight overshoot + correct |
| Typing | `input.value = text` | Sequential `Input.dispatchKeyEvent` with N-gram delays |
| Scrolling | `window.scrollTo(0, bottom)` | Chunked 200–400 px with 1–3 s pauses |
| Inter-profile wait | Fixed `sleep(120s)` | **Gaussian** delays (e.g. μ=120s, σ configurable; clamp to sane min/max) |

### 9.1 Mouse (Arm) — Phase 1 Algorithm

**Function:** `generate_ghost_cursor_path(start, end, viewport, rng) -> list[Point]`

**Required properties:**

1. **Duration** influenced by distance (Fitts’s Law–inspired): farther targets take longer.
2. **Minimum-Jerk** velocity profile (slow–fast–slow).
3. Path not a perfect straight line: control points with small noise / Bezier.
4. **Overshoot** with probability ~0.10: pass target by a few pixels, then correct back.
5. Output: `[{x, y, t_ms}, ...]` dense enough for smooth playback (~8–16 ms steps typical).
6. Coordinates clamped to viewport; integers at dispatch time.

**Phase 2:** optional `/v1/mouse/path_gan` returning GAN-sampled trajectories with the same wire format.

### 9.2 Keyboard (Fingers) — Phase 1 Algorithm

**Function:** `generate_keystroke_timeline(text, ngram_table) -> list[KeyEvent]`

**Required properties:**

1. For each digraph `(prev, curr)`, look up mean flight time from JSON; apply **±15%** uniform/Gaussian jitter.
2. Missing digraph → fallback base delay (e.g. 80–100 ms) + jitter.
3. After punctuation (`.`, `,`, `!`, `?`, `;`, `:`) insert **300–500 ms** pause.
4. Capitals / shift combinations: slightly longer flight time.
5. Optional Phase 2: rare typo + backspace (off by default in Phase 1).
6. Output events map cleanly to CDP `keyDown` / `keyUp` / `char` as required by Chrome.

**Data prep (offline, documented in repo):**

1. Use open keystroke dataset (e.g. Clarkson University Keystroke Dataset).
2. Compute average flight time per 2-letter combination.
3. Export `ngram_delays.json` consumed by Cloud Run.

### 9.3 Vision (Brain)

**Locate — profile CTA triage (first screenshot on a profile):**

> Classify the primary profile actions visible. Return JSON:
> `{ "profile_state": "can_connect_direct"|"can_connect_overflow"|"can_message"|"pending"|"unknown", "targets": [ { "label": "Connect"|"More"|"Message"|string, "x": number, "y": number, "confidence": number } ] }`

**Locate — task-specific** (`task` query param / field):  
`connect` | `more_menu` | `connect_in_menu` | `send_without_a_note` | `email_field` | `email_submit` | `message` | `message_box` | `send`

**Validate — after Connect click:**

Classify into:  
`invite_sent` | `note_choice` | `email_gate` | `weekly_limit` | `captcha` | `unusual_activity` | `pending` | `already_connected` | `unknown`

For `note_choice`, also return coordinates for **Send without a note** when visible.

**Validate — after Message click / send:**  
`composer_open` | `message_sent` | `unknown`

---

## 10. State Machine

### 10.1 Connect mode

```
IDLE
  → NAVIGATING
  → OBSERVING (screenshot + CTA triage)
  → SCROLLING (if not_visible)
  → branch:
       ├─ can_connect_direct → MOVING_CLICK_CONNECT
       └─ can_connect_overflow → MOVING_CLICK_MORE → OBSERVE_MENU → MOVING_CLICK_CONNECT_IN_MENU
  → VALIDATING_POST_CONNECT
       ├─ invite_sent                    → LOG connect_sent → WAIT_GAUSSIAN → NEXT_URL
       ├─ note_choice                    → MOVING_CLICK_SEND_WITHOUT_A_NOTE → LOG connect_sent → …
       ├─ email_gate                     → LOCATE_EMAIL → TYPE softCapEmail → CLICK_SUBMIT
       │                                    → LOG email_gate_filled
       │                                    → [optional SOFT_PAUSE 48h if pauseAfterEmailGate]
       ├─ weekly_limit                   → HARD_CAP_PAUSE (72–96h)
       ├─ captcha_or_unusual             → EMERGENCY_STOP (≥5d)
       ├─ pending / already_connected    → LOG skip → NEXT_URL
       └─ unknown                        → NEEDS_REVIEW
```

### 10.2 Message mode

```
IDLE
  → NAVIGATING
  → OBSERVING
  → SCROLLING (if needed)
  → MOVING_CLICK_MESSAGE
  → VALIDATING_COMPOSER
       ├─ composer_open → TYPE messageTemplate → MOVING_CLICK_SEND → VALIDATE message_sent → LOG → WAIT → NEXT_URL
       └─ not_connected / unknown → LOG not_connected | needs_review → NEXT_URL
```

### 10.3 View mode (V3 only)

```
IDLE
  → CHECK_DAILY_VIEW_BUDGET (abort/pause if exhausted)
  → NAVIGATING
  → OBSERVING (confirm profile loaded; no CTA required)
       ├─ view_blocked → LOG → NEXT_URL
       ├─ captcha_or_unusual → EMERGENCY_STOP
       └─ profile_ok → DWELL_GAUSSIAN
            → OPTIONAL_CHUNKED_SCROLL_AND_MOUSE_WANDER
            → LOG profile_viewed (increment view counter)
            → WAIT_GAUSSIAN
            → NEXT_URL
```

**Invariant:** View mode state machine has **no** edges to Connect/Message click states.

All UI transitions that click must be vision-validated after the action (planner-actor-validator lite).---

## 11. API Contracts (Cloud Run)

Base URL: `https://<service>.run.app`  
Auth (Phase 1): shared `X-API-Key` header.  
All responses JSON; screenshots as `multipart/form-data` or base64 in JSON (prefer multipart for size).

### 11.1 `POST /v1/vision/locate`

**Request:** image + `task` enum:

`profile_cta` | `connect` | `more_menu` | `connect_in_menu` | `send_without_a_note` | `email_field` | `email_submit` | `message` | `message_box` | `send`

**Response (single target):**

```json
{
  "status": "found",
  "label": "Connect",
  "x": 1042,
  "y": 218,
  "confidence": 0.86
}
```

**Response (`task=profile_cta` triage):**

```json
{
  "profile_state": "can_connect_overflow",
  "targets": [
    { "label": "More", "x": 1180, "y": 210, "confidence": 0.91 }
  ]
}
```

### 11.2 `POST /v1/vision/validate`

**Request:** image + `expected_after` (e.g. `connect_click`, `more_click`, `send_without_a_note_click`, `email_submit`, `message_click`, `send_click`).  
**Response:**

```json
{
  "state": "note_choice",
  "signals": ["Add a note", "Send without a note"],
  "targets": [
    { "label": "Send without a note", "x": 720, "y": 540, "confidence": 0.88 }
  ],
  "raw_summary": "Invite modal offering note vs no-note"
}
```

`state` enum:  
`invite_sent` | `note_choice` | `email_gate` | `weekly_limit` | `captcha` | `unusual_activity` | `pending` | `already_connected` | `composer_open` | `message_sent` | `unknown`
### 11.3 `POST /v1/mouse/path`

**Request:**

```json
{
  "start": {"x": 100, "y": 400},
  "end": {"x": 1042, "y": 218},
  "viewport": {"width": 1280, "height": 800},
  "overshoot_probability": 0.1
}
```

**Response:**

```json
{
  "points": [{"x": 100, "y": 400, "t_ms": 0}, {"x": 105, "y": 398, "t_ms": 12}]
}
```

### 11.4 `POST /v1/keyboard/timeline`

**Request:**

```json
{
  "text": "Hi Jane, enjoyed your post on ops hiring — would love to connect.",
  "locale": "en"
}
```

**Response:**

```json
{
  "events": [
    {"op": "keyDown", "key": "H", "code": "KeyH", "delay_ms": 0},
    {"op": "keyUp", "key": "H", "code": "KeyH", "delay_ms": 62},
    {"op": "keyDown", "key": "i", "code": "KeyI", "delay_ms": 89}
  ]
}
```

### 11.5 `GET /v1/health`

Liveness for Cloud Run + extension preflight.

---

## 12. Extension Technical Requirements

| ID | Requirement |
| --- | --- |
| E1 | Manifest V3; permissions minimally include: `debugger`, `tabs`, `windows`, `storage`, `alarms`, host permissions for LinkedIn + Cloud Run. |
| E2 | Attach `chrome.debugger` only to the worker tab; detach on job end/abort. |
| E3 | Playback must schedule events using cumulative delays from Arm/Fingers timelines. |
| E4 | Screenshots: `chrome.tabs.captureVisibleTab` on the worker window; ensure window not minimized. |
| E5 | Content script scans DOM text for known warning strings as a **belt-and-suspenders** layer alongside VLM validate (CAPTCHA, weekly limit, email to connect, unusual activity). |
| E6 | Persist: queue, settings (`softCapEmail`, `pauseAfterEmailGate`, mode), send log, cooldown_until, warm_up_stage in `chrome.storage.local`. |
| E7 | Never use `element.click()`, `HTMLElement.click`, or direct value assignment for connect/message/email paths. |
| E8 | Document that the yellow debugger banner is expected and harmless to LinkedIn page JS. |
| E9 | **Never** declare `web_accessible_resources` in `manifest.json` (see §12.1). |
| E10 | Do not ship publicly fetchable extension assets (e.g. `logo.png`) under any WAR-equivalent exposure. Keep all files private to the extension package. |

### 12.1 Bypass Web-Accessible Resource (WAR) Scans — Hard Requirement

LinkedIn (and similar sites) fingerprint known extensions by requesting internal asset URLs such as:

```text
chrome-extension://<EXTENSION_ID>/logo.png
```

If that URL returns `200`, the page can infer that a specific extension (or *an* extension with that path) is installed.

**Product rules:**

1. **`manifest.json` must omit the `web_accessible_resources` key entirely.** No empty array workaround that still documents intent — the key must not exist.
2. Because this is a **custom unpacked** extension, its ID is not in public blocklists; keeping assets non-WAR means LinkedIn **cannot** successfully fetch extension files to confirm presence.
3. UI icons for the Side Panel / action icon use normal `icons` / `action.default_icon` paths (those are **not** web-accessible to page JS). Do not also list them under `web_accessible_resources`.
4. CI / PR checklist: fail the build if `web_accessible_resources` appears anywhere in the extension manifest.
5. Content scripts must not inject `<img src="chrome-extension://…">` or otherwise expose extension URLs into the LinkedIn DOM.

---

## 13. Data Model (Local)

### 13.1 `SendEvent`

```ts
{
  id: string
  url: string
  sentAt: number          // epoch ms
  kind: "connect" | "message" | "view"
  outcome:
    | "connect_sent"
    | "email_gate_filled"
    | "pending"
    | "already_connected"
    | "message_sent"
    | "not_connected"
    | "profile_viewed"      // V3
    | "view_blocked"        // V3
    | "hard_cap"
    | "needs_review"
    | "error"
  jobId: string
}
```

### 13.2 `Job`

```ts
{
  id: string
  createdAt: number
  status: "running" | "paused" | "completed" | "stopped_safety"
  mode: "connect" | "message" | "auto" | "view"  // "view" only in V3 builds
  urls: string[]
  messageTemplate: string
  softCapEmail: string        // default "marcus.wong@linktal.com.au"
  pauseAfterEmailGate: boolean // default false (V1 dogfood)
  cursor: number
  results: Record<string, SendEvent["outcome"]>
}
```

### 13.3 `PolicyState`

```ts
{
  dailyCap: number              // default 15 (connects)
  rollingSoftCeiling: number    // default 85
  workingHours: { days: number[], startHour: number, endHour: number }
  softCapEmail: string          // default "marcus.wong@linktal.com.au"
  pauseAfterEmailGate: boolean
  accountTier: "free" | "sales_nav" | "recruiter_lite"  // V3
  dailyViewCap: number          // V3: default 120 (free) / 800 (nav)
  cooldownUntil: number | null
  cooldownReason: string | null
  warmUpStage: "manual_only" | "stage_a" | "stage_b" | "steady"
}
```---

## 14. LinkedIn Policy Constraints (Product Rules)

These are **hard product rules**, not suggestions:

| Rule | Value |
| --- | --- |
| Hard weekly (LinkedIn) | ~100 invites / rolling week — treat as absolute ceiling |
| Product rolling soft ceiling | Pause at 80–90 in last 168h (default 85) |
| Daily connect target | 15–20 steady state; warm-up lower |
| Daily profile views (free) | LinkedIn guideline ~150; product soft cap **≤120** (V3; also tracked for V1/V2 navigations once V3 counter ships) |
| Daily profile views (Sales Nav / Recruiter Lite) | LinkedIn guideline ~2000; product soft cap default **≤800** (configurable) |
| Warm-up Day 1–7 | No extension; manual 3–5/day |
| Warm-up Day 8–14 | Extension 5–10/day |
| Warm-up Day 15–21 | Increase 3–5 every other day toward ≤20–25 |
| Soft cap (email gate) | V1: fill `softCapEmail` (`marcus.wong@linktal.com.au`); optional 48h pause via `pauseAfterEmailGate` |
| Hard cap (weekly limit modal) | Pause 72–96h |
| Unusual activity / CAPTCHA | Pause ≥5 days |
| Low acceptance (10–15%) | Pause 2 days (V2) |
| Withdraw stale sent invites | Older than 3–4 weeks, weekly job (V2) |
| Working hours | Default business hours only |
| WAR fingerprinting | `web_accessible_resources` **forbidden** in manifest |
| Profile View mode | **V3 only** — no Connect/Message clicks |

---

## 15. Non-Functional Requirements

| ID | Requirement |
| --- | --- |
| NF1 | Extension must remain usable on a mid-range Windows laptop while a second window runs the job. |
| NF2 | Cloud Run cold start: extension retries with backoff; show “warming brain…” in UI. |
| NF3 | No LinkedIn passwords stored; uses the user’s existing browser session. |
| NF4 | Logs must not upload message content to third parties beyond the operator’s Cloud Run project. |
| NF5 | Deterministic wire formats so Hand can be tested with fixture timelines (no live VLM). |
| NF6 | Configurability for delays/caps without rebuilding (storage-backed settings). |

---

## 16. UX Requirements (Extension)

1. **Side Panel / Popup**
   - Job mode: Connect / Message / Auto (**V3:** + View)
   - Textarea for URLs (one per line)
   - Message template field (Message mode)
   - Soft-cap email field (default `marcus.wong@linktal.com.au`)
   - Caps, warm-up stage, `pauseAfterEmailGate` toggle
   - **V3:** account tier + daily view budget meter (shared across modes)
   - Start / Pause / Abort
   - Live quota meters: connects today / last 168h / (**V3**) views today / cooldown banner
2. **Worker window**
   - Opened unfocused; optional small on-screen badge “Automation worker — do not minimize”
3. **Safety banner**
   - Persistent red state when cooldown active, with reason + unlock time

---

## 17. Success Metrics

| Metric | Target |
| --- | --- |
| Connect C1 (direct Connect) success on clean profiles | ≥80% internal test set |
| Connect C2 (More → Connect) success on overflow profiles | ≥80% internal test set |
| Post-connect A2 clicks **Send without a note** (not Add a note) | 100% when that control is present |
| Email gate A3 types configured softCapEmail | 100% when gate shown |
| Message M1: Message → type → Send | ≥80% on 1st-degree test set |
| Hard-cap / CAPTCHA false-proceed | **0** |
| Debugger-only input on connect/message/email paths | 100% |
| `web_accessible_resources` absent from manifest | 100% (CI-enforced) |
| User can work in another window during run | Yes, without OS cursor theft |
| Rolling-window connect enforcement | Never exceed configured soft ceiling |

---

## 18. Test Plan

### 18.1 Unit (Backend)

- Minimum-Jerk path: monotonic time, ends near target, overshoot frequency ~10%.
- N-gram timeline: length matches text; punctuation gaps in 300–500 ms; jitter within ±15%.
- Gaussian delay sampler: empirical mean ≈ μ within tolerance; respects clamps.

### 18.2 Integration (Extension + Mock Brain)

- Fixture: direct Connect → invite_sent.
- Fixture: More → Connect → note_choice → Send without a note.
- Fixture: Connect → email_gate → type `marcus.wong@linktal.com.au` → submit.
- Fixture: Message → composer → type template → Send.
- Minimized window → job pauses.
- Inject fake connect log → rolling ceiling blocks next connect.
- Manifest lint: fail if `web_accessible_resources` present.

### 18.3 Manual / Staging

- Real profiles covering C1, C2, A1, A2, A3, M1.
- Multi-URL queue (3–5) in background window while using another window.
- Confirm yellow debugger banner appears; automation still functions.
- Confirm LinkedIn page cannot fetch any `chrome-extension://<id>/…` asset (DevTools from page context).

### 18.4 Explicit Non-Tests

- Do **not** test CAPTCHA bypass.
- Do **not** load-test against LinkedIn with high QPS.
- Do **not** treat “Add a note” (invite note) as Phase 1 happy path.

---

## 19. Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| LinkedIn ToS / account restriction | Strict caps, warm-up, instant stop on warnings; internal-only use |
| Extension fingerprint via WAR fetches | Omit `web_accessible_resources`; CI lint; never expose `chrome-extension://` URLs in page DOM |
| VLM mis-click | Validate loop; `needs_review` queue; low confidence → skip |
| Blank screenshots | Ban minimize; detect blank frames; auto-pause |
| Debugger banner UX | Document as expected |
| Cloud Run cost/latency | Cache nothing sensitive; compress screenshots; short timeouts + retry |
| UI language / A/B variants | Vision prompts include synonyms (More/⋯, Send without a note); validate enum covers unknowns |
| Email gate trust signal | Log every fill; optional `pauseAfterEmailGate` for steady-state |

---

## 20. Compliance & Ethics

- Tooling is for **Linktal colleagues’ own accounts** only (see README).
- Operators must follow warm-up and daily caps.
- No credential harvesting, no CAPTCHA solving, no multi-tenant abuse farm.
- Operators acknowledge LinkedIn ToS risk before first Start (checkbox in UI).

---

## 21. Repo Deliverables (Implementation Map)

```
linkedln-automation-tools/
├── PRD.md                          ← this document
├── README.md
├── extension/                      ← The Hand (MV3)
│   ├── manifest.json
│   ├── background/
│   ├── sidepanel/
│   ├── content/
│   └── lib/ (debugger playback, storage, policy)
├── backend/                        ← Brain / Arm / Fingers (FastAPI)
│   ├── app/main.py
│   ├── app/api/
│   ├── app/vision/
│   ├── app/mouse/ghost_cursor.py
│   ├── app/keyboard/ngram_typer.py
│   ├── data/ngram_delays.json
│   ├── Dockerfile
│   └── requirements.txt
├── scripts/
│   └── build_ngram_delays.py       ← offline dataset → JSON
└── docs/
    └── warm-up-and-policy.md
```

---

## 22. Open Questions

| # | Question | Default assumption until decided |
| --- | --- | --- |
| Q1 | Exact VLM provider for Phase 1 (GoClick vs GPT-4o vs other)? | Pluggable interface; start with one Vision API behind `/v1/vision/*` |
| Q2 | Personalization: scrape first name vs template-only? | Template-only in Phase 1 |
| Q3 | Connect with note (“Add a note”)? | **Out of Phase 1** — always **Send without a note** |
| Q4 | Multi-monitor / DPI scaling for coordinates? | Normalize screenshot ↔ CSS pixels via `devicePixelRatio` in Hand |
| Q5 | Cloud Run region / auth method for prod? | API key in Phase 1; OIDC later |
| Q6 | After email gate fill, pause 48h? | Default **false** for dogfood; recommend **true** in steady state |
| Q7 | Separate daily cap for Message mode? | Configurable; messages do not consume connect invite quota |
| Q8 | Ship profile-view counter in V1 (even without View mode)? | Recommended yes as prep for V3; View **mode** UI still V3-only |
| Q9 | Default free-tier dailyViewCap 120 vs 150? | **120** (buffer under LinkedIn ~150 guideline) |

---

## 23. Implementation Order

### V1 checklist (Connect + Message)

1. **Backend skeleton** on FastAPI: health + mouse path + keyboard timeline (mock vision for bring-up).
2. **N-gram JSON** checked in (even if initially hand-seeded / partially computed).
3. **Extension**: worker window (`focused: false`), debugger playback; **manifest without `web_accessible_resources`**.
4. **Vision integrate — Connect:** C1 / C2 → A1 / A2 (Send without a note) / A3 (email `marcus.wong@linktal.com.au`).
5. **Vision integrate — Message:** M1 Message → type → Send.
6. **Policy engine:** rolling 168h connect log, daily connect cap, Gaussian waits, cooldowns.
7. **Watchdogs:** content-script string detectors + vision validate enums.
8. **Cloud Run Dockerfile** + deploy instructions.
9. **Internal dogfood** on 1 account at warm-up caps only.

### V2 checklist (still Connect + Message)

1. Sent-invites withdrawer + acceptance-rate monitor.
2. GAN/RNN optional endpoints; Connect-with-note option.
3. Auth, observability, config polish.

### V3 checklist (Profile View)

1. Add `view` job mode + state machine (§10.3); gate CTA clicks hard-off.
2. Shared daily `profileViewEvents` counter + `dailyViewCap` by account tier.
3. Browse behavior: dwell + chunked scroll + mouse wander; outcomes `profile_viewed` / `view_blocked`.
4. Side Panel: View mode + view budget meter + copy about “Who viewed your profile.”
5. Dogfood View queues separately from Connect queues; never burst the daily view cap.
---

## 24. Appendix A — Warm-Up Method (Operator Runbook)

| Days | Mode | Cap |
| --- | --- | --- |
| 1–7 | Manual only; browse feed; 3–5 connects/day | Extension OFF |
| 8–14 | Extension ON | 5–10 / day |
| 15–21 | Ramp | +3–5 every other day toward ≤20 |
| Steady | Extension | 15–20 / day; rolling soft ceiling 80–90 |

---

## 25. Appendix B — `generate_ghost_cursor_path` Mathematical Intent

Phase 1 does **not** require a trained GAN. It must implement:

1. **Fitts’s Law–styled duration**  
   \( T = a + b \log_2(1 + D/W) \) with clamped human-like bounds (e.g. ~300–1800 ms depending on distance).
2. **Minimum-Jerk trajectory** along a (slightly curved) path parameter \( u \in [0,1] \):  
   position easing \( u(t) = 10t^3 - 15t^4 + 6t^5 \) (classic minimum-jerk polynomial).
3. **Lateral noise / Bezier control points** so the path is not colinear.
4. **Probabilistic overshoot** (~10%): extend past end by small δ, then append a short corrective minimum-jerk segment back to target.
5. Emit sampled points at fixed dt for Hand playback.

(Detailed numeric constants to be finalized in code + unit tests; this appendix locks the *intent*.)

---

## 26. Appendix C — Answer to Background Multi-URL Question

**Yes.** With the extension built as specified:

- User inserts multiple LinkedIn URLs in the Side Panel and chooses **Connect**, **Message**, or (**V3**) **View** mode.
- Extension pops/opens a **new worker window** with `focused: false` (behind the user’s current window).
- That window processes each URL under policy caps.
- User continues work in another window/screen.
- **Do not minimize** the worker window, or vision screenshots will fail; the product must pause and warn if minimization is detected.

---

## 27. Appendix D — Scenario Cheat Sheet (PRD v1.2)

### Connect (V1+)

| Step | Variant | What the Hand does |
| --- | --- | --- |
| Find CTA | Connect visible | Click **Connect** |
| Find CTA | Connect in three-dot menu | Click **More / ...** then click **Connect** |
| After | Success / Pending | Log `connect_sent` |
| After | Note choice | Click **Send without a note** |
| After | Email required | Type `marcus.wong@linktal.com.au` then submit |

### Message — already connected (V1+)

| Step | What the Hand does |
| --- | --- |
| Find CTA | Click **Message** |
| Compose | Type message template with N-gram delays |
| Send | Click **Send** |

### Profile View — Who viewed your profile (**V3 only**)

| Step | What the Hand does |
| --- | --- |
| Open URL | Navigate to profile (counts as 1 daily view) |
| Browse | Dwell + optional scroll / mouse wander |
| Outreach | **None** — no Connect, Message, or Follow |
| Log | `profile_viewed` |

### Stealth

| Rule | Requirement |
| --- | --- |
| WAR scans | **No** `web_accessible_resources` in `manifest.json` |

### Version map

| Version | Modes |
| --- | --- |
| V1 | `connect`, `message`, `auto` |
| V2 | Same modes + hygiene / biometric upgrades |
| V3 | Adds `view` |

---

*End of PRD v1.2*
