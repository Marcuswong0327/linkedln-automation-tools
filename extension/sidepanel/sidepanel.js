import { getSettings, saveSettings } from "../lib/api.js";

const $ = (id) => document.getElementById(id);

async function refreshDashboard() {
  const dash = await chrome.runtime.sendMessage({ type: "get_dashboard" });
  if (!dash) return;
  const { settings, job, daily, rolling, cooldown, health } = dash;
  $("backendUrl").value = settings.backendUrl || "";
  $("apiKey").value = settings.apiKey || "";
  $("softCapEmail").value = settings.softCapEmail || "";
  $("pauseAfterEmailGate").checked = !!settings.pauseAfterEmailGate;
  $("fastDogfood").checked = settings.fastDogfood !== false;

  let healthText = "Brain: unreachable";
  if (health?.ok) {
    const model = health.vision_model || "qwen/qwen2.5-vl-72b-instruct";
    healthText = `Brain OK · ${health.vision_provider || "?"} · ${model} · ready=${health.vision_ready} · key_set=${health.openrouter_key_set}`;
    if (health.vision_error) healthText += ` · err=${health.vision_error}`;
  } else if (health?.error) {
    healthText = `Brain error: ${health.error}`;
  }
  $("health").textContent = healthText;

  let cooldownText = "none";
  if (cooldown?.until && Date.now() < cooldown.until) {
    cooldownText = `${cooldown.reason} until ${new Date(cooldown.until).toLocaleString()}`;
  }
  $("quota").textContent = `Today: ${daily} / ${settings.dailyCap} · Rolling 7d: ${rolling} / ${settings.rollingSoftCeiling} · Cooldown: ${cooldownText}`;

  if (job) {
    $("status").textContent = JSON.stringify(
      {
        status: job.status,
        cursor: job.cursor,
        total: job.urls?.length,
        stopReason: job.stopReason,
        lastDetail: job.lastDetail,
        results: job.results,
      },
      null,
      2
    );
  }
}

$("saveSettings").addEventListener("click", async () => {
  await saveSettings({
    backendUrl: $("backendUrl").value.trim(),
    apiKey: $("apiKey").value.trim(),
    softCapEmail: $("softCapEmail").value.trim(),
    pauseAfterEmailGate: $("pauseAfterEmailGate").checked,
    fastDogfood: $("fastDogfood").checked,
  });
  await refreshDashboard();
});

$("start").addEventListener("click", async () => {
  const urls = $("urls").value.split(/\r?\n/);
  $("status").textContent = "Starting…";
  await chrome.runtime.sendMessage({ type: "start_job", urls });
  setTimeout(refreshDashboard, 500);
});

$("pause").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "pause_job" });
  await refreshDashboard();
});

$("abort").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "abort_job" });
  await refreshDashboard();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "job_status") {
    $("status").textContent = JSON.stringify(msg.status, null, 2);
    refreshDashboard();
  }
});

refreshDashboard();
setInterval(refreshDashboard, 4000);
