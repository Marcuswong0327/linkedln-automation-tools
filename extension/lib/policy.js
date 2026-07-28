const SEND_LOG_KEY = "sendEvents";
const JOB_KEY = "activeJob";
const COOLDOWN_KEY = "cooldown";

export function gaussianDelayMs(meanMs, sigmaMs, minMs, maxMs) {
  // Box-Muller
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  const val = meanMs + z * sigmaMs;
  return Math.max(minMs, Math.min(maxMs, val));
}

export async function getSendEvents() {
  const { [SEND_LOG_KEY]: events = [] } = await chrome.storage.local.get(SEND_LOG_KEY);
  return events;
}

export async function appendSendEvent(event) {
  const events = await getSendEvents();
  events.push(event);
  // Keep last 500
  await chrome.storage.local.set({ [SEND_LOG_KEY]: events.slice(-500) });
}

export async function countRollingConnects(windowMs = 168 * 3600 * 1000) {
  const now = Date.now();
  const events = await getSendEvents();
  return events.filter(
    (e) =>
      e.kind === "connect" &&
      ["connect_sent", "email_gate_filled"].includes(e.outcome) &&
      now - e.sentAt < windowMs
  ).length;
}

export async function countTodayConnects() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const t0 = start.getTime();
  const events = await getSendEvents();
  return events.filter(
    (e) =>
      e.kind === "connect" &&
      ["connect_sent", "email_gate_filled"].includes(e.outcome) &&
      e.sentAt >= t0
  ).length;
}

export async function assertCanConnect(settings) {
  const cooldown = await getCooldown();
  if (cooldown?.until && Date.now() < cooldown.until) {
    throw Object.assign(new Error(`Cooldown: ${cooldown.reason}`), {
      code: "cooldown",
      cooldown,
    });
  }
  const daily = await countTodayConnects();
  if (daily >= (settings.dailyCap ?? 15)) {
    throw Object.assign(new Error("Daily connect cap reached"), { code: "daily_cap" });
  }
  const rolling = await countRollingConnects();
  if (rolling >= (settings.rollingSoftCeiling ?? 85)) {
    throw Object.assign(new Error("Rolling 7-day soft ceiling reached"), {
      code: "rolling_cap",
    });
  }
  return { daily, rolling };
}

/** Message mode: honor safety cooldown, but do not use connect invite caps. */
export async function assertCanMessage(_settings) {
  const cooldown = await getCooldown();
  if (cooldown?.until && Date.now() < cooldown.until) {
    throw Object.assign(new Error(`Cooldown: ${cooldown.reason}`), {
      code: "cooldown",
      cooldown,
    });
  }
  return { ok: true };
}

export async function setCooldown(reason, durationMs) {
  const until = Date.now() + durationMs;
  await chrome.storage.local.set({
    [COOLDOWN_KEY]: { reason, until },
  });
}

export async function getCooldown() {
  const { [COOLDOWN_KEY]: c = null } = await chrome.storage.local.get(COOLDOWN_KEY);
  return c;
}

export async function saveJob(job) {
  await chrome.storage.local.set({ [JOB_KEY]: job });
}

export async function getJob() {
  const { [JOB_KEY]: job = null } = await chrome.storage.local.get(JOB_KEY);
  return job;
}

export { JOB_KEY, SEND_LOG_KEY, COOLDOWN_KEY };
