const DEFAULTS = {
  backendUrl: "http://127.0.0.1:8000",
  apiKey: "dev-local-key",
  softCapEmail: "marcus.wong@linktal.com.au",
  pauseAfterEmailGate: false,
  dailyCap: 15,
  rollingSoftCeiling: 85,
  cursorStart: { x: 120, y: 400 }, // only used if randomizeCursorStart is false
  randomizeCursorStart: true,
  /** When true, use short delays for local dogfood (not production pacing). */
  fastDogfood: true,
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

export async function saveSettings(partial) {
  await chrome.storage.local.set(partial);
}

export async function apiHealth(settings) {
  const res = await fetch(`${settings.backendUrl}/v1/health`);
  if (!res.ok) throw new Error(`Health failed: ${res.status}`);
  return res.json();
}

async function apiJson(settings, path, body) {
  const res = await fetch(`${settings.backendUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": settings.apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path} ${res.status}: ${text}`);
  }
  return res.json();
}

async function apiForm(settings, path, form) {
  const res = await fetch(`${settings.backendUrl}${path}`, {
    method: "POST",
    headers: { "X-API-Key": settings.apiKey },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path} ${res.status}: ${text}`);
  }
  return res.json();
}

export async function locate(settings, dataUrl, task) {
  const blob = await (await fetch(dataUrl)).blob();
  const form = new FormData();
  form.append("task", task);
  form.append("image", blob, "viewport.png");
  return apiForm(settings, "/v1/vision/locate", form);
}

export async function validate(settings, dataUrl, expectedAfter) {
  const blob = await (await fetch(dataUrl)).blob();
  const form = new FormData();
  form.append("expected_after", expectedAfter);
  form.append("image", blob, "viewport.png");
  return apiForm(settings, "/v1/vision/validate", form);
}

export async function mousePath(settings, start, end, viewport) {
  return apiJson(settings, "/v1/mouse/path", {
    start,
    end,
    viewport,
    // omit overshoot_probability → backend randomizes 0.10–0.25 each path
  });
}

export async function keyboardTimeline(settings, text) {
  return apiJson(settings, "/v1/keyboard/timeline", { text, locale: "en" });
}
