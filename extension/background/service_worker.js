import { startConnectJob, pauseJob, abortJob } from "../lib/connect_job.js";
import {
  getJob,
  countTodayConnects,
  countRollingConnects,
  getCooldown,
  setCooldown,
  saveJob,
} from "../lib/policy.js";
import { getSettings, apiHealth } from "../lib/api.js";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === "start_job") {
      startConnectJob(msg.urls || []).catch((err) => {
        chrome.runtime
          .sendMessage({ type: "job_status", status: { phase: "error", error: String(err) } })
          .catch(() => {});
      });
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "pause_job") {
      await pauseJob();
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "abort_job") {
      await abortJob();
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "get_dashboard") {
      const settings = await getSettings();
      let health = null;
      try {
        health = await apiHealth(settings);
      } catch (e) {
        health = { ok: false, error: String(e.message || e) };
      }
      sendResponse({
        settings,
        job: await getJob(),
        daily: await countTodayConnects(),
        rolling: await countRollingConnects(),
        cooldown: await getCooldown(),
        health,
      });
      return;
    }
    if (msg?.type === "watchdog_alert") {
      const reason = msg.reason || "watchdog";
      const ms =
        reason === "weekly_limit"
          ? 84 * 3600 * 1000
          : reason === "email_gate"
            ? 48 * 3600 * 1000
            : 5 * 24 * 3600 * 1000;
      await setCooldown(reason, ms);
      const job = await getJob();
      if (job && job.status === "running") {
        job.status = "stopped_safety";
        job.stopReason = reason;
        await saveJob(job);
      }
      sendResponse({ ok: true });
      return;
    }
  })();
  return true;
});
