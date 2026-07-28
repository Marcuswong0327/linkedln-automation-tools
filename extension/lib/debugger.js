function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function attachDebugger(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* not attached */
  }
  await sleep(150);
  await chrome.debugger.attach({ tabId }, "1.3");
  await chrome.debugger.sendCommand({ tabId }, "Page.enable");
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  await chrome.debugger.sendCommand({ tabId }, "Input.setIgnoreInputEvents", {
    ignore: false,
  }).catch(() => {});
}

export async function detachDebugger(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* already detached */
  }
}

async function dispatch(tabId, method, params) {
  await chrome.debugger.sendCommand({ tabId }, method, params);
}

export async function playMousePath(tabId, points) {
  if (!points?.length) return;
  let lastT = 0;
  for (const p of points) {
    const wait = Math.max(0, (p.t_ms ?? 0) - lastT);
    if (wait) await sleep(wait);
    lastT = p.t_ms ?? lastT;
    await dispatch(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: p.x,
      y: p.y,
      buttons: 0,
    });
  }
  const last = points[points.length - 1];
  await dispatch(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: last.x,
    y: last.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await sleep(40 + Math.random() * 60);
  await dispatch(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: last.x,
    y: last.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

export async function playKeyTimeline(tabId, events) {
  for (const ev of events || []) {
    if (ev.delay_ms) await sleep(ev.delay_ms);
    const isKeyUp = ev.op === "keyUp";
    const params = {
      type: isKeyUp ? "keyUp" : "keyDown",
      key: ev.key,
      code: ev.code,
      windowsVirtualKeyCode: 0,
      nativeVirtualKeyCode: 0,
    };
    // Printable chars: keyDown (no text) → char → keyUp.
    // Do NOT also set text on keyDown — LinkedIn contenteditable inserts twice (Hhii…).
    if (!isKeyUp && ev.text && ev.key !== "Shift") {
      await dispatch(tabId, "Input.dispatchKeyEvent", params);
      await dispatch(tabId, "Input.dispatchKeyEvent", {
        type: "char",
        text: ev.text,
        unmodifiedText: ev.text,
        key: ev.key,
        code: ev.code,
      });
    } else {
      await dispatch(tabId, "Input.dispatchKeyEvent", params);
    }
  }
}

export async function scrollChunk(tabId, deltaY) {
  await dispatch(tabId, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 400,
    y: 400,
    deltaX: 0,
    deltaY,
  });
}

export async function captureTab(windowId, tabId) {
  // Prefer CDP screenshot — works on unfocused worker tabs and avoids captureVisibleTab
  // permission quirks ("Either the '<all_urls>' or 'activeTab' permission is required").
  if (tabId != null) {
    try {
      await chrome.tabs.update(tabId, { active: true });
    } catch {
      /* ignore */
    }
    await sleep(200);
    try {
      const result = await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
      });
      if (result?.data) {
        return `data:image/png;base64,${result.data}`;
      }
    } catch (err) {
      console.warn("Page.captureScreenshot failed, falling back:", err);
    }
  }

  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (err) {
    try {
      return await chrome.tabs.captureVisibleTab({ format: "png" });
    } catch {
      throw new Error(`Screenshot failed: ${err?.message || err}`);
    }
  }
}
