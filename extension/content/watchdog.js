(() => {
  // Keep patterns tight — broad words like "verification" false-trigger on normal LinkedIn UI.
  const RULES = [
    { reason: "weekly_limit", re: /you've reached the weekly invitation limit|reached the weekly invitation limit/i },
    {
      reason: "unusual_activity",
      re: /we'?ve restricted your account|unusual activity from your account|are you a robot|start a security verification|solve this puzzle/i,
    },
    {
      reason: "email_gate",
      re: /include their email|email address to connect|enter .+@.+ email|to verify you know/i,
    },
  ];

  let lastHit = "";
  const check = () => {
    const text = document.body?.innerText?.slice(0, 20000) || "";
    for (const rule of RULES) {
      if (rule.re.test(text)) {
        const key = `${rule.reason}:${text.slice(0, 80)}`;
        if (key === lastHit) return;
        lastHit = key;
        chrome.runtime.sendMessage({ type: "watchdog_alert", reason: rule.reason }).catch(() => {});
        break;
      }
    }
  };

  setInterval(check, 3000);
})();
