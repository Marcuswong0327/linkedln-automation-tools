import {
  getSettings,
  locate,
  validate,
  mousePath,
  keyboardTimeline,
} from "./api.js";
import {
  attachDebugger,
  detachDebugger,
  playMousePath,
  playKeyTimeline,
  scrollChunk,
  captureTab,
} from "./debugger.js";
import {
  assertCanConnect,
  appendSendEvent,
  gaussianDelayMs,
  saveJob,
  getJob,
  setCooldown,
} from "./policy.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function broadcast(status) {
  chrome.runtime.sendMessage({ type: "job_status", status }).catch(() => {});
}

async function getViewport(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    }),
  });
  return results?.[0]?.result || { width: 1280, height: 800, dpr: 1 };
}

function toCssCoords(point, viewport, screenshotNatural) {
  // captureVisibleTab is device pixels; debugger Input uses CSS pixels
  const dpr = viewport.dpr || 1;
  if (!screenshotNatural) {
    return { x: point.x / dpr, y: point.y / dpr };
  }
  const scaleX = viewport.width / screenshotNatural.width;
  const scaleY = viewport.height / screenshotNatural.height;
  return { x: point.x * scaleX, y: point.y * scaleY };
}

async function screenshotSize(dataUrl) {
  // Decode PNG IHDR via fetch+createImageBitmap when available
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close?.();
    return size;
  } catch {
    return null;
  }
}

async function moveClick(tabId, settings, cursor, target, viewport, shotSize) {
  const end = toCssCoords(target, viewport, shotSize);
  const path = await mousePath(settings, cursor, end, {
    width: viewport.width,
    height: viewport.height,
  });
  await playMousePath(tabId, path.points);
  return { x: end.x, y: end.y };
}

async function ensureWorkerWindow(url) {
  const job = await getJob();
  let windowId = job?.workerWindowId;
  let tabId = job?.workerTabId;

  if (windowId) {
    try {
      const win = await chrome.windows.get(windowId);
      if (win.state === "minimized") {
        throw Object.assign(new Error("Worker window is minimized — restore it and resume"), {
          code: "minimized",
        });
      }
    } catch (e) {
      if (e.code === "minimized") throw e;
      windowId = null;
      tabId = null;
    }
  }

  if (!windowId) {
    const win = await chrome.windows.create({
      url: url || "https://www.linkedin.com/feed/",
      focused: false,
      type: "normal",
      width: 1280,
      height: 900,
    });
    windowId = win.id;
    tabId = win.tabs?.[0]?.id;
  }

  return { windowId, tabId };
}

async function navigate(tabId, url) {
  await chrome.tabs.update(tabId, { url, active: true });
  await waitTabComplete(tabId);
  await sleep(1500 + Math.random() * 1000);
}

function waitTabComplete(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 30000);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

function pickTarget(locateResult) {
  if (!locateResult) return null;
  if (locateResult.status === "not_found") return null;
  if (locateResult?.targets?.length) {
    const t = locateResult.targets[0];
    return { x: t.x, y: t.y, label: t.label, confidence: t.confidence };
  }
  if (locateResult?.x != null && locateResult?.y != null) {
    return {
      x: locateResult.x,
      y: locateResult.y,
      label: locateResult.label,
      confidence: locateResult.confidence,
    };
  }
  return null;
}

function isOverflowState(triage) {
  const state = (triage?.profile_state || "").toLowerCase();
  if (state === "can_connect_overflow") return true;
  if (state === "can_connect_direct") return false;
  const signals = (triage?.signals || []).join(" ").toLowerCase();
  // Follow + Message + More, no Connect on bar → C2
  if (/follow/.test(signals) && /more|\.\.\.|…/.test(signals) && !/\bconnect\b/.test(signals)) {
    return true;
  }
  return false;
}

/** Simulated resting cursor before the first click on a profile (CSS pixels). */
function randomCursorStart(viewport, settings) {
  if (settings?.randomizeCursorStart === false && settings?.cursorStart) {
    return {
      x: Number(settings.cursorStart.x) || 120,
      y: Number(settings.cursorStart.y) || 400,
    };
  }
  const w = Math.max(320, Number(viewport?.width) || 1280);
  const h = Math.max(400, Number(viewport?.height) || 800);
  // Natural rest zone: left/mid content, below LinkedIn global nav, above footer
  const xMin = 60;
  const xMax = Math.max(xMin + 40, Math.min(w * 0.42, 520));
  const yMin = Math.max(120, h * 0.28);
  const yMax = Math.max(yMin + 40, Math.min(h - 80, h * 0.78));
  return {
    x: Math.round(xMin + Math.random() * (xMax - xMin)),
    y: Math.round(yMin + Math.random() * (yMax - yMin)),
  };
}

async function processProfile(tabId, windowId, url, settings, job) {
  broadcast({ phase: "navigating", url });
  await navigate(tabId, url);
  const readMs = settings.fastDogfood
    ? gaussianDelayMs(2500, 800, 1200, 5000)
    : gaussianDelayMs(8000, 3000, 3000, 20000);
  await sleep(readMs);

  const viewport = await getViewport(tabId);
  // Random start per profile → ghost_cursor paths from here; later clicks chain from last end
  let cursor = randomCursorStart(viewport, settings);
  broadcast({ phase: "cursor_start", cursor, url });

  // Scroll a bit like a human reading
  await scrollChunk(tabId, 250 + Math.random() * 150);
  await sleep(1200 + Math.random() * 1500);

  let dataUrl = await captureTab(windowId, tabId);
  let shotSize = await screenshotSize(dataUrl);

  // C1 vs C2 triage (Lycius-style: Follow + Message + More → Connect under ...)
  broadcast({ phase: "triaging_cta", url });
  const triage = await locate(settings, dataUrl, "profile_cta");
  broadcast({
    phase: "triage_result",
    profile_state: triage.profile_state,
    signals: triage.signals,
    url,
  });

  if (triage.profile_state === "pending" || triage.profile_state === "already_connected") {
    return { outcome: triage.profile_state };
  }

  let usedOverflow = isOverflowState(triage);
  let target = pickTarget(triage);

  if (!usedOverflow) {
    // Prefer explicit Connect on bar
    const loc = await locate(settings, dataUrl, "connect");
    const connectTarget = pickTarget(loc);
    if (connectTarget && (loc.confidence == null || loc.confidence >= 0.45)) {
      target = connectTarget;
      usedOverflow = false;
    } else {
      usedOverflow = true;
      target = null;
    }
  }

  if (usedOverflow) {
    broadcast({ phase: "c2_more_menu", url });
    const moreLoc = target?.label && /more/i.test(target.label)
      ? { status: "found", ...target }
      : await locate(settings, dataUrl, "more_menu");
    target = pickTarget(moreLoc) || target;
    if (!target) {
      return { outcome: "needs_review", detail: "C2: More (...) not found" };
    }
    cursor = await moveClick(tabId, settings, cursor, target, viewport, shotSize);
    await sleep(900 + Math.random() * 700);

    dataUrl = await captureTab(windowId, tabId);
    shotSize = await screenshotSize(dataUrl);
    const menuLoc = await locate(settings, dataUrl, "connect_in_menu");
    const menuTarget = pickTarget(menuLoc);
    if (!menuTarget) {
      return { outcome: "needs_review", detail: "C2: More opened but Connect not in menu" };
    }
    cursor = await moveClick(tabId, settings, cursor, menuTarget, viewport, shotSize);
    await sleep(900 + Math.random() * 800);
  } else {
    broadcast({ phase: "c1_connect_direct", url });
    if (!target) {
      return { outcome: "needs_review", detail: "C1: Connect not found on bar" };
    }
    cursor = await moveClick(tabId, settings, cursor, target, viewport, shotSize);
    await sleep(800 + Math.random() * 700);
  }

  dataUrl = await captureTab(windowId, tabId);
  shotSize = await screenshotSize(dataUrl);
  const post = await validate(settings, dataUrl, "connect_click");
  broadcast({ phase: "post_connect", state: post.state, url });

  if (post.state === "weekly_limit") {
    await setCooldown("weekly_limit", 84 * 3600 * 1000);
    return { outcome: "hard_cap", detail: "Weekly invitation limit" };
  }
  if (post.state === "captcha" || post.state === "unusual_activity") {
    await setCooldown("unusual_activity", 5 * 24 * 3600 * 1000);
    return { outcome: "error", detail: post.state };
  }
  if (post.state === "pending" || post.state === "already_connected") {
    return { outcome: post.state };
  }

  if (post.state === "note_choice") {
    let noteTarget =
      (post.targets || []).find((t) => /send without a note/i.test(t.label || "")) ||
      pickTarget(await locate(settings, dataUrl, "send_without_a_note"));
    if (!noteTarget) {
      return { outcome: "needs_review", detail: "note_choice but button missing" };
    }
    cursor = await moveClick(tabId, settings, cursor, noteTarget, viewport, shotSize);
    await sleep(1000 + Math.random() * 800);
    const after = await validate(settings, await captureTab(windowId, tabId), "send_without_a_note_click");
    if (after.state === "email_gate") {
      return await handleEmailGate(tabId, windowId, settings, cursor, viewport);
    }
    return { outcome: "connect_sent" };
  }

  if (post.state === "email_gate") {
    return await handleEmailGate(tabId, windowId, settings, cursor, viewport);
  }

  if (post.state === "invite_sent") {
    return { outcome: "connect_sent" };
  }

  // Unknown — try Send without a note anyway if visible
  const maybe = pickTarget(await locate(settings, dataUrl, "send_without_a_note"));
  if (maybe) {
    cursor = await moveClick(tabId, settings, cursor, maybe, viewport, shotSize);
    await sleep(800);
    return { outcome: "connect_sent" };
  }

  return { outcome: "needs_review", detail: `Unknown post state: ${post.state}` };
}

async function handleEmailGate(tabId, windowId, settings, cursor, viewport) {
  broadcast({ phase: "email_gate" });
  let dataUrl = await captureTab(windowId, tabId);
  let shotSize = await screenshotSize(dataUrl);
  const field = pickTarget(await locate(settings, dataUrl, "email_field"));
  if (!field) {
    return { outcome: "needs_review", detail: "email_gate without field" };
  }
  cursor = await moveClick(tabId, settings, cursor, field, viewport, shotSize);
  await sleep(300);
  const timeline = await keyboardTimeline(settings, settings.softCapEmail);
  await playKeyTimeline(tabId, timeline.events);
  await sleep(500);
  dataUrl = await captureTab(windowId, tabId);
  shotSize = await screenshotSize(dataUrl);
  const submit = pickTarget(await locate(settings, dataUrl, "email_submit"));
  if (submit) {
    cursor = await moveClick(tabId, settings, cursor, submit, viewport, shotSize);
  }
  if (settings.pauseAfterEmailGate) {
    await setCooldown("email_gate", 48 * 3600 * 1000);
  }
  return { outcome: "email_gate_filled" };
}

export async function startConnectJob(urls) {
  const settings = await getSettings();
  const clean = urls.map((u) => u.trim()).filter((u) => u.includes("linkedin.com/"));
  if (!clean.length) throw new Error("No valid LinkedIn URLs");

  let job = {
    id: `job_${Date.now()}`,
    mode: "connect",
    status: "running",
    urls: clean,
    cursor: 0,
    results: {},
    createdAt: Date.now(),
    softCapEmail: settings.softCapEmail,
  };

  const { windowId, tabId } = await ensureWorkerWindow(clean[0]);
  job.workerWindowId = windowId;
  job.workerTabId = tabId;
  await saveJob(job);

  await attachDebugger(tabId);
  broadcast({ phase: "started", total: clean.length });

  try {
    for (let i = 0; i < clean.length; i++) {
      job = await getJob();
      if (!job || job.status === "paused" || job.status === "aborted") {
        broadcast({ phase: "paused_or_aborted" });
        break;
      }

      const url = clean[i];
      job.cursor = i;
      await saveJob(job);

      try {
        await assertCanConnect(settings);
      } catch (e) {
        job.status = "stopped_safety";
        job.stopReason = e.message;
        await saveJob(job);
        broadcast({ phase: "stopped_safety", reason: e.message });
        break;
      }

      // Re-check minimized
      const win = await chrome.windows.get(windowId);
      if (win.state === "minimized") {
        job.status = "paused";
        job.stopReason = "Worker window minimized";
        await saveJob(job);
        broadcast({ phase: "paused", reason: "minimized" });
        break;
      }

      let result;
      try {
        result = await processProfile(tabId, windowId, url, settings, job);
      } catch (err) {
        result = { outcome: "error", detail: String(err?.message || err) };
      }

      job.results[url] = result.outcome;
      job.lastDetail = result.detail || null;
      job.lastPhase = result.outcome;
      await saveJob(job);
      await appendSendEvent({
        id: `${job.id}_${i}`,
        url,
        sentAt: Date.now(),
        kind: "connect",
        outcome: result.outcome,
        jobId: job.id,
        detail: result.detail || null,
      });
      broadcast({
        phase: "profile_done",
        url,
        outcome: result.outcome,
        detail: result.detail || null,
        index: i + 1,
        total: clean.length,
      });

      if (result.outcome === "hard_cap" || result.detail === "unusual_activity" || result.detail === "captcha") {
        job.status = "stopped_safety";
        await saveJob(job);
        break;
      }

      if (i < clean.length - 1) {
        const gap = settings.fastDogfood
          ? gaussianDelayMs(8_000, 3_000, 4_000, 20_000)
          : gaussianDelayMs(90_000, 40_000, 45_000, 8 * 60_000);
        broadcast({ phase: "waiting", ms: Math.round(gap) });
        await sleep(gap);
        job = await getJob();
        if (!job || job.status !== "running") break;
      }
    }

    job = await getJob();
    if (job && job.status === "running") {
      job.status = "completed";
      await saveJob(job);
      broadcast({ phase: "completed", results: job.results });
    }
  } finally {
    await detachDebugger(tabId);
  }
}

export async function pauseJob() {
  const job = await getJob();
  if (job) {
    job.status = "paused";
    await saveJob(job);
  }
}

export async function abortJob() {
  const job = await getJob();
  if (job) {
    job.status = "aborted";
    await saveJob(job);
    if (job.workerTabId) await detachDebugger(job.workerTabId);
  }
}
