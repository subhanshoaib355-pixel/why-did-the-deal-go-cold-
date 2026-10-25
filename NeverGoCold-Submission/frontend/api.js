const API_BASE = (window.NEVERGOCOLD_API || "http://localhost:8000").replace(/\/$/, "");
const AS_OF = new Date("2026-10-24T00:00:00");

var leads = [];
var logEntries = [];
var pipelineError = "";
var tempChart = null;
var pipelineLoading = false;

function daysSince(date) {
  if (!date) return 0;
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return 0;
  return Math.max(0, Math.round((AS_OF - parsed) / 86400000));
}

function temperature(verdict) {
  const worldTemperature = verdict.worldModel && verdict.worldModel.temperature;
  if (worldTemperature === "hot" || worldTemperature === "warm" || worldTemperature === "cold" || worldTemperature === "frozen") {
    return worldTemperature;
  }
  const status = (verdict.journey && verdict.journey.crmStatus ? verdict.journey.crmStatus : "").toLowerCase();
  if (status === "won") return "hot";
  if (verdict.confidence === "LOW" || status === "lost") return "frozen";
  const negative = (verdict.sentiments || []).some((item) => item.label === "negative");
  if (negative || (verdict.pain && verdict.pain.tags && verdict.pain.tags.length)) return "cold";
  return verdict.confidence === "HIGH" ? "warm" : "cold";
}

function mapDeal(row) {
  const verdict = row.verdict || row;
  const reason = verdict.reason || "";
  const dealId = row.deal_id || (verdict.journey && verdict.journey.dealId) || "";
  const companyMatch = reason.match(/^(.+?) \(D\d{3}\)/);
  const contactMatch = reason.match(/Contact: ([^,.\n]+)/);
  const roleMatch = reason.match(/Contact: [^,]+, ([^.\n]+)/);
  const emailMatch = reason.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  const stopNote = (verdict.journey && verdict.journey.activityStopNote) || "";
  const dated = stopNote.match(/last_activity_date (\d{4}-\d{2}-\d{2})/) || reason.match(/last_activity_date (\d{4}-\d{2}-\d{2})/);
  const last = (verdict.journey && verdict.journey.activityStoppedAt) || (dated ? dated[1] : "");
  const recommendations = verdict.recommendations || [];
  const feedback = verdict.feedback || [];
  const temp = temperature(verdict);
  const status = (verdict.journey && verdict.journey.crmStatus ? verdict.journey.crmStatus : "").toLowerCase();
  const priorColdContext = verdict.priorColdContext || null;
  return {
    id: dealId,
    name: contactMatch ? contactMatch[1].trim() : dealId,
    company: companyMatch ? companyMatch[1].trim() : dealId,
    email: emailMatch ? emailMatch[0] : "",
    role: roleMatch ? roleMatch[1].trim() : "",
    stage: (verdict.journey && (verdict.journey.stage || verdict.journey.crmStage)) || "",
    lastContact: last,
    daysSilent: daysSince(last),
    temp,
    agentStatus: status === "won" ? "monitoring" : temp === "cold" || temp === "frozen" ? "drafted" : "monitoring",
    nextAction: recommendations[0] ? recommendations[0].action : "Review evidence",
    value: "",
    confidence: verdict.confidence || "",
    reasoning: reason,
    sentimentWarning: verdict.sentimentWarning || "",
    painTags: (verdict.pain && Array.isArray(verdict.pain.tags) ? verdict.pain.tags : [])
      .map((tag) => tag.tag)
      .filter((tag) => typeof tag === "string"),
    priorColdContext,
    suggestion: recommendations.map((item) => item.action).join(" ") || "No recommendation",
    message: recommendations.map((item) => `${item.priority}. ${item.action}`).join("\n"),
    timeline: feedback.map((item) => ({
      icon: item.source === "call_note" ? "phone" : "mail",
      color: "#4f46e5",
      bg: "#eef2ff",
      title: `${item.source} ${item.id}`,
      sub: item.text,
      time: item.date,
    })),
  };
}

function mapTrace(trace) {
  const events = trace && Array.isArray(trace.events) ? trace.events : [];
  return events.map((event) => ({
    type: event.kind === "recall" ? "detected" : event.kind === "result" ? "sent" : "drafted",
    badge: event.kind,
    title: `${event.from} -> ${event.to}`,
    sub: event.summary,
    time: `${event.durationMs} ms`,
    date: (event.timestamp || "").slice(0, 10),
  }));
}

function renderDashboard() {
  const cold = leads.filter((lead) => lead.temp === "cold" || lead.temp === "frozen");
  const sentimentFallbackCount = leads.filter((lead) => lead.sentimentWarning).length;
  const won = leads.filter((lead) => lead.stage === "Closed-Won").length;
  const actions = leads.filter((lead) => lead.nextAction && lead.nextAction !== "Review evidence").length;
  const setText = (id, value) => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  };
  setText("kpi-total", leads.length ? String(leads.length) : "0");
  setText("kpi-total-note", pipelineError ? "API unavailable" : "Deals returned by the agent");
  setText("kpi-cold", String(cold.length));
  setText("kpi-cold-note", pipelineError ? pipelineError : "Cold or frozen from the agent");
  setText("kpi-actions", String(actions));
  setText("kpi-actions-note", "Deals with a recommendation");
  setText("kpi-won", leads.length ? `${Math.round((won / leads.length) * 100)}%` : "0%");
  setText("kpi-won-note", `${won} closed won`);
  setText("nav-leads-count", String(cold.length));
  setText("nav-log-count", String(logEntries.length));
  setText("status-sub", pipelineLoading
    ? "Loading deals"
    : `Monitoring ${leads.length} deals${sentimentFallbackCount ? ` · local sentiment fallback for ${sentimentFallbackCount}` : ""}`);
  setText("chart-subtitle", `${leads.length} deals`);
  setText("urgent-title", `${cold.length} Leads Need Your Attention`);
  ["hot", "warm", "cold", "frozen"].forEach((name) => {
    setText(`temp-${name}`, `${leads.filter((lead) => lead.temp === name).length} leads`);
  });

  const activity = document.getElementById("activity-list");
  if (activity) {
    activity.replaceChildren();
    const rows = logEntries.slice(0, 5);
    if (!rows.length) {
      const empty = document.createElement("li");
      empty.className = "activity-item";
      empty.textContent = pipelineError ? `Could not load the agent log. ${pipelineError}` : pipelineLoading ? "Loading agent activity..." : "No trace events yet.";
      activity.appendChild(empty);
    }
    rows.forEach((entry) => {
      const item = document.createElement("li");
      item.className = "activity-item";
      const icon = document.createElement("div");
      icon.className = "activity-icon";
      icon.style.background = "#eef2ff";
      icon.style.color = "#4f46e5";
      const text = document.createElement("div");
      text.className = "activity-text";
      const title = document.createElement("div");
      title.className = "activity-title";
      title.textContent = entry.title;
      const sub = document.createElement("div");
      sub.className = "activity-sub";
      sub.textContent = entry.sub;
      text.append(title, sub);
      const time = document.createElement("div");
      time.className = "activity-time";
      time.textContent = entry.time;
      item.append(icon, text, time);
      activity.appendChild(item);
    });
  }

  const urgent = document.getElementById("urgent-cards");
  if (urgent) {
    urgent.replaceChildren();
    cold.slice().sort((a, b) => b.daysSilent - a.daysSilent).slice(0, 3).forEach((lead) => {
      const card = document.createElement("div");
      card.style.cssText = "flex:1;min-width:200px;background:white;border:1px solid #fee2e2;border-radius:8px;padding:12px 14px;cursor:pointer;";
      card.addEventListener("click", () => {
        openLead(lead.id);
        navigate("leads", document.getElementById("nav-leads"));
      });
      const title = document.createElement("div");
      title.style.cssText = "font-size:13px;font-weight:600;margin-bottom:3px";
      title.textContent = `${lead.name} · ${lead.company}`;
      const detail = document.createElement("div");
      detail.style.cssText = "font-size:12px;color:var(--text-muted)";
      detail.textContent = `${lead.daysSilent} days silent · ${lead.stage} · ${lead.confidence}`;
      const badge = document.createElement("div");
      badge.style.marginTop = "8px";
      badge.innerHTML = `<span class="badge badge-${lead.temp}"><span class="badge-dot"></span>${lead.temp}</span>`;
      card.append(title, detail, badge);
      urgent.appendChild(card);
    });
    if (!cold.length) {
      const empty = document.createElement("div");
      empty.textContent = pipelineError || "No cold or frozen deals in this run.";
      urgent.appendChild(empty);
    }
  }
  initChart();
  if (window.lucide) lucide.createIcons();
}

async function runAgentApi(dealId, refresh = false) {
  const response = await fetch(`${API_BASE}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deal_id: dealId, refresh }),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`The agent API returned an invalid response (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const details = [body.error, body.detail]
      .filter((value) => typeof value === "string" && value.trim())
      .join(": ");
    throw new Error(details || `Agent API returned HTTP ${response.status}.`);
  }
  const rows = Array.isArray(body.deals) ? body.deals : body.deal_id ? [body] : [];
  return { rows, trace: body.trace };
}

async function loadPipeline(refresh = false) {
  if (pipelineLoading) return;
  pipelineLoading = true;
  pipelineError = "";
  const sub = document.getElementById("topbar-sub");
  if (sub) sub.textContent = "Loading deals from the agent...";
  renderDashboard();
  try {
    const result = await runAgentApi("all", refresh);
    leads = result.rows.map(mapDeal);
    logEntries = mapTrace(result.trace);
    pipelineError = "";
    if (sub) sub.textContent = `Sample mode · ${leads.length} deals from ${API_BASE}`;
  } catch (err) {
    leads = [];
    logEntries = [];
    pipelineError = err && err.message ? err.message : "request failed";
    if (sub) sub.textContent = "Agent API unavailable";
    if (typeof showToast === "function") showToast(`Could not load deals from ${API_BASE}`);
  } finally {
    pipelineLoading = false;
  }
  if (typeof filterLeads === "function") filterLeads();
  if (typeof renderContacts === "function") renderContacts(leads);
  if (typeof renderInsights === "function") renderInsights();
  if (typeof renderLog === "function") renderLog();
  renderDashboard();
}
