/**
 * Page controller. All business numbers come from /api/* — nothing is
 * hard-coded here. Each completed operation rewrites `data-evidence-result`
 * on the result section so the before/after content can be checked.
 */

const $ = (sel) => document.querySelector(sel);

const resultEl = $("#result");
const bodyEl = $("#result-body");
const digestEl = $("#evidence-digest");
const statusEl = $("#action-status");
const panelEl = $("#backfill-panel");
const formEl = $("#backfill-form");
const formErrorEl = $("#form-error");
const tooltipEl = document.createElement("div");
tooltipEl.className = "tooltip";
tooltipEl.setAttribute("role", "tooltip");
document.body.appendChild(tooltipEl);

let state = null;
let activeWindow = null;

/* ---------- utilities ---------- */

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

function fmtNumber(value, digits = 1) {
  if (value == null || Number.isNaN(value)) return "—";
  return Number(value).toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtInt(value) {
  return value == null ? "—" : Number(value).toLocaleString("zh-CN");
}

function money(value) {
  if (value == null) return "—";
  return `¥${Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function setBusy(busy) {
  document.querySelectorAll(".actions .btn").forEach((btn) => {
    btn.disabled = busy;
  });
  const submit = $("#btn-submit-backfill");
  if (submit) submit.disabled = busy;
}

function setEvidence(kind, digest) {
  resultEl.dataset.evidenceResult = digest || "none";
  resultEl.dataset.resultKind = kind;
  digestEl.textContent = digest ? `证据摘要：${digest}` : "证据摘要：—";
}

async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { accept: "application/json", ...(options.body ? { "content-type": "application/json" } : {}) },
    ...options,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = { ok: false, error: `服务返回了非 JSON 响应（HTTP ${res.status}）` };
  }
  if (!res.ok || payload.ok === false) {
    const err = new Error(payload.error || `HTTP ${res.status}`);
    err.payload = payload;
    throw err;
  }
  return payload;
}

/* ---------- state + selects ---------- */

async function loadState() {
  const query = activeWindow
    ? `?from=${encodeURIComponent(activeWindow.from)}&to=${encodeURIComponent(activeWindow.to)}`
    : "";
  state = await request(`/api/state${query}`);
  if (!activeWindow) {
    activeWindow = { ...state.defaultWindow };
    const fromInput = $("#window-from");
    const toInput = $("#window-to");
    if (fromInput && !fromInput.value) fromInput.value = activeWindow.from;
    if (toInput && !toInput.value) toInput.value = activeWindow.to;
  }
  $("#window-label").textContent = `${activeWindow.from} → ${activeWindow.to}`;
  $("#register-label").textContent = state.venue.name;
  $("#ticket-total").textContent = `${fmtInt(state.transactionCount)} 张`;

  const windowSelect = $("#night-select");
  const previous = windowSelect.value;
  windowSelect.innerHTML = state.sessions
    .map(
      (s) =>
        `<option value="${esc(s.nightKey)}">${esc(s.nightKey)} ${esc(s.weekdayLabel)}${s.crossesMidnight ? "（跨零点）" : ""}</option>`,
    )
    .join("");
  if (previous && state.sessions.some((s) => s.nightKey === previous)) {
    windowSelect.value = previous;
  }
  const stallSelect = $("#stall-select");
  stallSelect.innerHTML = state.venue.stalls
    .map((s) => `<option value="${esc(s.id)}">${esc(s.id)} · ${esc(s.name)}</option>`)
    .join("");
  const areaSelect = $("#area-select");
  areaSelect.innerHTML = state.venue.areas
    .map((a) => `<option value="${esc(a.id)}">${esc(a.id)} · ${esc(a.name)}</option>`)
    .join("");
}

function windowQuery() {
  return `?from=${encodeURIComponent(activeWindow.from)}&to=${encodeURIComponent(activeWindow.to)}`;
}

function applyWindowFromInputs() {
  const from = $("#window-from").value;
  const to = $("#window-to").value;
  activeWindow = { from, to };
}

/* ---------- rendering: analysis ---------- */

function renderAnalysis(data) {
  const s = data.summary;
  const nights = data.nights;
  const maxRate = Math.max(0.001, ...nights.map((n) => n.ticketsPerHour || 0));
  const topStalls = [...data.stalls].sort((a, b) => (b.ticketsPerHour || 0) - (a.ticketsPerHour || 0));

  bodyEl.innerHTML = `
    <div class="hero-band">
      <div>
        <div class="hero-value">${fmtNumber(s.ticketsPerAvailableHour, 2)}</div>
        <div class="hero-label">票 / 每可经营小时（全部在营摊位）</div>
      </div>
      <p class="hero-aside">
        窗口 ${esc(s.windowLabel)}，共 ${fmtInt(s.sessionCount)} 个营业日、${fmtInt(s.stallNights)} 个摊位班次。
        可经营 ${fmtNumber(s.availableHours, 1)} 小时，其中 ${fmtNumber(s.closedHours, 1)} 小时因登记停业不可经营。
      </p>
    </div>

    <div class="stat-row">
      <div class="stat">
        <span class="stat-label">可用时段分母</span>
        <span class="stat-value">${fmtNumber(s.availableHours, 1)} h</span>
        <span class="stat-sub">已扣除 ${fmtNumber(s.closedHours, 1)} h 停业</span>
      </div>
      <div class="stat">
        <span class="stat-label">入账票数</span>
        <span class="stat-value">${fmtInt(s.ticketCount)}</span>
        <span class="stat-sub">${fmtInt(s.unallocatedCount)} 张无法归属</span>
      </div>
      <div class="stat">
        <span class="stat-label">营业额</span>
        <span class="stat-value">${money(s.revenue)}</span>
        <span class="stat-sub">仅统计已归属的票</span>
      </div>
      <div class="stat">
        <span class="stat-label">停业登记</span>
        <span class="stat-value">${fmtInt(s.closureCount)}</span>
        <span class="stat-sub">${fmtInt(s.supersededCount)} 条被后续登记取代</span>
      </div>
    </div>

    <h3 class="section-title">逐场出票密度</h3>
    <p class="section-note">每一列是一个营业日（以开市日期命名，跨零点不拆分）；票/小时按当晚实际可经营时长计算。</p>
    ${nightChart(nights, maxRate)}

    <h3 class="section-title">摊位汇总</h3>
    <p class="section-note">利用率以 票/可经营小时 计；分母只包含摊位登记窗口与市场营业时段相交、且未停业的部分。</p>
    <div class="table-wrap">
      <table>
        <caption>各摊位在分析窗口内的可用时长与出票</caption>
        <thead>
          <tr>
            <th>摊位</th><th>区域</th><th class="num">班次</th>
            <th class="num">可经营 h</th><th class="num">停业 h</th>
            <th class="num">票数</th><th class="num">票/小时</th><th class="num">营业额</th>
          </tr>
        </thead>
        <tbody>
          ${topStalls
            .map(
              (st) => `
            <tr>
              <td>${esc(st.id)} · ${esc(st.name)}</td>
              <td>${esc(st.areaName)}</td>
              <td class="num">${fmtInt(st.scheduledNights)}</td>
              <td class="num">${fmtNumber(st.availableHours, 1)}</td>
              <td class="num">${fmtNumber(st.cutHours, 1)}</td>
              <td class="num">${fmtInt(st.tickets)}</td>
              <td class="num">${fmtNumber(st.ticketsPerHour, 2)}</td>
              <td class="num">${money(st.revenue)}</td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>

    ${closuresSection(data.closures)}

    <h3 class="section-title">逐班次明细</h3>
    <p class="section-note">每个摊位 × 营业日一行；展开可逐票核对是否落在可经营时段内。</p>
    <div class="table-wrap">
      <table>
        <caption>${fmtInt(data.rows.length)} 个摊位班次</caption>
        <thead>
          <tr>
            <th>营业日</th><th>摊位</th><th>摊位窗口</th><th>可经营时段</th>
            <th class="num">可经营 min</th><th class="num">停业 min</th>
            <th class="num">票数</th><th class="num">票/小时</th>
          </tr>
        </thead>
        <tbody>
          ${data.rows
            .map(
              (r) => `
            <tr>
              <td>${esc(r.nightKey)} ${r.crossesMidnight ? `<span class="tag" title="跨零点，仍属同一营业日">跨零点</span>` : ""}<br /><span class="note">${esc(r.weekdayLabel)}</span></td>
              <td>${esc(r.stallId)} · ${esc(r.stallName)}</td>
              <td>${esc(r.rawLabel)}</td>
              <td>${esc(r.availableLabel)}${r.closures.length ? `<br /><span class="note">扣除：${r.closures.map((c) => esc(c.reason)).join("；")}</span>` : ""}</td>
              <td class="num">${fmtInt(r.availableMinutes)}</td>
              <td class="num">${fmtInt(r.closedMinutes)}</td>
              <td class="num">${fmtInt(r.ticketCount)}${r.ticketsInClosedWindow ? `<br /><span class="tag warn"><span class="dot"></span>${fmtInt(r.ticketsInClosedWindow)} 票在停业窗口</span>` : ""}</td>
              <td class="num">${fmtNumber(r.ticketsPerHour, 2)}</td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>

    ${unallocatedSection(data.unallocated)}
  `;
  bindChartHover(data.nights);
  setEvidence("analysis", data.evidence.digest);
  statusEl.textContent = `已运行原营业分析：${fmtInt(data.rows.length)} 个班次、${fmtInt(data.summary.ticketCount)} 张已归属票。`;
  resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

function nightChart(nights, maxRate) {
  const width = 880;
  const height = 260;
  const pad = { top: 18, right: 16, bottom: 44, left: 44 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const band = innerW / nights.length;
  const barW = Math.min(24, band * 0.5);
  const ticks = 4;
  const y = (v) => pad.top + innerH - (v / maxRate) * innerH;

  const grid = [];
  for (let i = 0; i <= ticks; i += 1) {
    const value = (maxRate / ticks) * i;
    grid.push(`
      <line x1="${pad.left}" x2="${width - pad.right}" y1="${y(value)}" y2="${y(value)}" />
      <text x="${pad.left - 8}" y="${y(value) + 3.5}" text-anchor="end">${fmtNumber(value, 2)}</text>
    `);
  }

  const bars = nights.map((n, i) => {
    const value = n.ticketsPerHour || 0;
    const cx = pad.left + band * i + band / 2;
    const x = cx - barW / 2;
    const yy = y(value);
    const h = pad.top + innerH - yy;
    const label = `${n.label}${n.crossesMidnight ? "（跨零点）" : ""}`;
    const r = 4;
    // 4px rounded top, square at the baseline
    const path =
      h <= 0
        ? ""
        : `M${x},${pad.top + innerH} L${x},${yy + r} Q${x},${yy} ${x + r},${yy} L${x + barW - r},${yy} Q${x + barW},${yy} ${x + barW},${yy + r} L${x + barW},${pad.top + innerH} Z`;
    return `
      <g>
        ${path ? `<path class="bar" d="${path}" />` : ""}
        <rect class="bar-hit" x="${pad.left + band * i}" y="${pad.top}" width="${band}" height="${innerH}"
          tabindex="0" role="img"
          aria-label="${esc(label)}：${fmtNumber(value, 2)} 票每小时，可经营 ${fmtNumber(n.availableHours, 1)} 小时"
          data-i="${i}" />
        <text class="value-label" x="${cx}" y="${yy - 6}" text-anchor="middle">${fmtNumber(value, 2)}</text>
        <text class="night-label" x="${cx}" y="${height - 22}" text-anchor="middle">${esc(n.label)}</text>
        ${n.crossesMidnight ? `<text x="${cx}" y="${height - 8}" text-anchor="middle" fill="var(--muted)" font-size="10">跨零点</text>` : ""}
      </g>
    `;
  });

  return `
    <figure class="chart" style="margin:0 0 26px">
      <svg viewBox="0 0 ${width} ${height}" role="group" aria-label="逐场出票密度柱状图">
        <g class="grid">${grid.join("")}</g>
        ${bars.join("")}
      </svg>
      <ul class="legend" aria-hidden="true">
        <li><span class="swatch" style="background:var(--series-1)"></span>票 / 可经营小时</li>
      </ul>
    </figure>
  `;
}

function bindChartHover(nights) {
  document.querySelectorAll(".bar-hit").forEach((el) => {
    const i = Number(el.dataset.i);
    const n = nights[i];
    const show = (evt) => {
      tooltipEl.innerHTML = `<strong>${esc(n.label)}${n.crossesMidnight ? " · 跨零点" : ""}</strong>
        <div>${fmtNumber(n.ticketsPerHour, 2)} 票 / 小时</div>
        <div class="muted">可经营 ${fmtNumber(n.availableHours, 1)} h · 停业 ${fmtNumber(n.cutHours, 1)} h</div>
        <div class="muted">${fmtInt(n.tickets)} 张票</div>`;
      const rect = el.getBoundingClientRect();
      tooltipEl.style.left = `${evt.clientX ?? rect.left + rect.width / 2}px`;
      tooltipEl.style.top = `${evt.clientY ?? rect.top}px`;
      tooltipEl.classList.add("visible");
    };
    const hide = () => tooltipEl.classList.remove("visible");
    el.addEventListener("mousemove", show);
    el.addEventListener("mouseenter", show);
    el.addEventListener("mouseleave", hide);
    el.addEventListener("focus", () => {
      const rect = el.getBoundingClientRect();
      show({ clientX: rect.left + rect.width / 2, clientY: rect.top });
    });
    el.addEventListener("blur", hide);
  });
}

function closuresSection(closures) {
  if (!closures.length) return "";
  return `
    <h3 class="section-title">停业登记</h3>
    <p class="section-note">这些区间已从可经营时段中扣除；“推导”记录表示登记缺结束时刻，按恢复营业点算到收市。</p>
    <div class="table-wrap">
      <table>
        <caption>${fmtInt(closures.length)} 条停业登记</caption>
        <thead>
          <tr><th>编号</th><th>形态</th><th>范围</th><th>营业日</th><th>停业区间</th><th class="num">分钟</th><th>原因</th></tr>
        </thead>
        <tbody>
          ${closures
            .map(
              (c) => `
            <tr>
              <td>${esc(c.id)}</td>
              <td>${c.kind === "mirror-inferred" ? `<span class="tag">${esc(c.kindLabel)}</span>` : esc(c.kindLabel)}</td>
              <td>${esc(c.scopeLabel)}</td>
              <td>${esc(c.nightKey)}</td>
              <td>${esc(c.windowLabel)}</td>
              <td class="num">${fmtInt(c.minutes)}</td>
              <td>${esc(c.reason)}${c.supersededBy ? `<br /><span class="note">被 ${esc(c.supersededBy)} 取代</span>` : ""}</td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function unallocatedSection(rows) {
  if (!rows.length) {
    return `<div class="banner info"><h3>逐票归属完整</h3><p>所有票面都落在一个营业日或已明确登记的营业日中。</p></div>`;
  }
  return `
    <div class="banner warn">
      <h3>${fmtInt(rows.length)} 张票无法归属</h3>
      <p>这些票面不落在任何营业时段内，或指向未登记的摊位；它们不进入任何班次的分子。</p>
      <ul class="delta-list">
        ${rows
          .map(
            (r) => `<li><span>${esc(r.id)} · ${esc(r.stallId)} · ${esc(r.label)}</span><span class="num">${money(r.amount)}</span></li>`,
          )
          .join("")}
      </ul>
    </div>
  `;
}

/* ---------- rendering: availability ---------- */

function renderAvailability(data) {
  const s = data.summary;
  const nights = data.byNight;
  bodyEl.innerHTML = `
    <div class="hero-band">
      <div>
        <div class="hero-value">${fmtNumber(s.availableHours, 1)} h</div>
        <div class="hero-label">可用时段分母合计（真正可经营的分钟数）</div>
      </div>
      <p class="hero-aside">${esc(s.definition)}</p>
    </div>

    <div class="stat-row">
      <div class="stat">
        <span class="stat-label">登记窗口合计</span>
        <span class="stat-value">${fmtNumber(s.rawHours, 1)} h</span>
        <span class="stat-sub">摊位窗口 ∩ 营业时段</span>
      </div>
      <div class="stat">
        <span class="stat-label">停业扣除</span>
        <span class="stat-value">${fmtNumber(s.closedHours, 1)} h</span>
        <span class="stat-sub">全部来自登记停业</span>
      </div>
      <div class="stat">
        <span class="stat-label">摊位班次</span>
        <span class="stat-value">${fmtInt(s.rows)}</span>
        <span class="stat-sub">逐班次求交、求差</span>
      </div>
    </div>

    <h3 class="section-title">逐场可经营时长</h3>
    <p class="section-note">跨零点的营业日只出现一次；日期是开市日期。</p>
    <div class="table-wrap">
      <table>
        <caption>按营业日汇总</caption>
        <thead>
          <tr><th>营业日</th><th>星期</th><th class="num">营业时长 h</th><th class="num">可经营 h</th><th class="num">停业 h</th><th class="num">票数</th></tr>
        </thead>
        <tbody>
          ${nights
            .map(
              (n) => `
            <tr>
              <td>${esc(n.nightKey)}${n.crossesMidnight ? ` <span class="tag">跨零点</span>` : ""}</td>
              <td>${esc(n.weekdayLabel)}</td>
              <td class="num">${fmtNumber(n.sessionHours, 1)}</td>
              <td class="num">${fmtNumber(n.availableHours, 1)}</td>
              <td class="num">${fmtNumber(n.cutHours, 1)}</td>
              <td class="num">${fmtInt(n.tickets)}</td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>

    <h3 class="section-title">逐班次分母</h3>
    <p class="section-note">每一行列出实际可经营的连续时段，可直接对照票面时间。</p>
    <div class="table-wrap">
      <table>
        <caption>${fmtInt(data.rows.length)} 个摊位班次的可经营时段</caption>
        <thead>
          <tr><th>营业日</th><th>摊位</th><th>可经营时段</th><th class="num">可经营 min</th><th class="num">停业 min</th></tr>
        </thead>
        <tbody>
          ${data.rows
            .map(
              (r) => `
            <tr>
              <td>${esc(r.nightKey)}${r.crossesMidnight ? ` <span class="tag">跨零点</span>` : ""}</td>
              <td>${esc(r.stallId)} · ${esc(r.stallName)}</td>
              <td>${r.segments.map((seg) => `<span class="tag">${esc(seg.label)} · ${fmtInt(seg.minutes)} min</span>`).join(" ") || "—"}</td>
              <td class="num">${fmtInt(r.availableMinutes)}</td>
              <td class="num">${fmtInt(r.closedMinutes)}</td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
  setEvidence("availability", data.evidence.digest);
  statusEl.textContent = `已计算可用时段分母：${fmtNumber(s.availableHours, 1)} 小时，扣除停业 ${fmtNumber(s.closedHours, 1)} 小时。`;
  resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---------- rendering: backfill impact ---------- */

function renderBackfill(data) {
  const imp = data.impact;
  const c = data.closure;
  const delta = imp.availabilityDelta || [];
  const tickets = imp.tickets || [];

  bodyEl.innerHTML = `
    <div class="banner info">
      <h3>已补录 ${esc(c.id)}（第 ${fmtInt(imp.revision)} 次修订）</h3>
      <p>${esc(c.scope === "venue" ? "全场" : c.scope === "area" ? `区域 ${c.areaId}` : `摊位 ${c.stallId}`)}
        · 营业日 ${esc(c.nightKey)} · ${esc(c.windowLabel)} · ${esc(c.reason)}</p>
    </div>

    <h3 class="section-title">受影响的班次</h3>
    <p class="section-note">只回查同一营业日内、在该停业区间内有可经营时长的班次。</p>
    ${
      delta.length
        ? `<ul class="delta-list">
            ${delta
              .map(
                (d) => `<li><span>${esc(d.stallId)} · ${esc(d.stallName)} · ${esc(d.nightKey)}</span>
                  <span class="num">${fmtInt(d.beforeMinutes)} → ${fmtInt(d.afterMinutes)} min（−${fmtInt(d.lostMinutes)}）</span></li>`,
              )
              .join("")}
          </ul>`
        : `<p class="note">该停业区间未与任何在营班次相交，分母不变。</p>`
    }

    <h3 class="section-title" style="margin-top:22px">票面归属回查</h3>
    <p class="section-note">
      共 ${fmtInt(imp.ticketCount)} 张票落在停业窗口内。
      ${imp.ticketAttributionStable ? "这些票的营业日归属保持不变，只是不再计入可经营时段内。" : "有票面归属需要人工复核。"}
    </p>
    ${
      tickets.length
        ? `<div class="table-wrap">
            <table>
              <caption>停业窗口内的票</caption>
              <thead><tr><th>票号</th><th>摊位</th><th>票面时间</th><th>票面日期</th><th>归属营业日</th><th>入账依据</th><th class="num">金额</th></tr></thead>
              <tbody>
                ${tickets
                  .map(
                    (t) => `<tr>
                      <td>${esc(t.id)}</td>
                      <td>${esc(t.stallId)}</td>
                      <td>${esc(t.occurredLabel)}</td>
                      <td>${esc(t.ticketDate)}</td>
                      <td>${esc(t.attributedNightKey || "—")}${t.attributedNightKey !== t.ticketDate ? ` <span class="tag">跨零点归属</span>` : ""}</td>
                      <td>${esc(basisLabel(t.postedVia))}</td>
                      <td class="num">${money(t.amount)}</td>
                    </tr>`,
                  )
                  .join("")}
              </tbody>
            </table>
          </div>`
        : `<p class="note">停业窗口内没有票面记录。</p>`
    }

    ${
      imp.overlappingClosures && imp.overlappingClosures.length
        ? `<div class="banner">
            <h3>与既有停业重叠</h3>
            <p>${imp.overlappingClosures.map((o) => `${esc(o.id)}（${esc(o.overlapLabel)}）`).join("；")}</p>
          </div>`
        : ""
    }

    ${
      imp.superseded && imp.superseded.length
        ? `<div class="banner"><h3>替代了推导型记录</h3>
             <p>${imp.superseded.map((s) => `${esc(s.id)}：${esc(s.reason)}`).join("；")}</p></div>`
        : ""
    }

    <h3 class="section-title" style="margin-top:22px">修订后的逐班次明细</h3>
    <div class="table-wrap">
      <table>
        <caption>${fmtInt(data.rows.length)} 个相关班次（补录后）</caption>
        <thead>
          <tr><th>营业日</th><th>摊位</th><th class="num">可经营 min</th><th class="num">停业 min</th><th class="num">票数</th><th>停业构成</th></tr>
        </thead>
        <tbody>
          ${data.rows
            .map(
              (r) => `<tr>
                <td>${esc(r.nightKey)} ${esc(r.weekdayLabel)}</td>
                <td>${esc(r.stallId)} · ${esc(r.stallName)}</td>
                <td class="num">${fmtInt(r.availableMinutes)}</td>
                <td class="num">${fmtInt(r.closedMinutes)}</td>
                <td class="num">${fmtInt(r.tickets.length)}</td>
                <td>${r.closures.map((x) => `${esc(x.id)} · ${fmtInt(x.minutes)} min`).join("<br />") || "—"}</td>
              </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
  setEvidence("backfill", data.evidence.digest);
  resultEl.dataset.beforeDigest = data.beforeDigest;
  statusEl.textContent = `已补录 ${c.id} 并回查：影响 ${fmtInt(delta.length)} 个班次、${fmtInt(imp.ticketCount)} 张票。`;
  resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

function basisLabel(basis) {
  return (
    {
      clock: "票面时间落在此营业日",
      "clock-after-midnight": "票面时间在此营业日跨零点段",
      "clock-cross-midnight": "票面时间在此营业日跨零点段",
      "session-slot": "登记表明确营业日",
      "outside-calendar": "不在任何营业时段",
      "unknown-session": "营业日不在日历中",
      "unknown-stall": "摊位未登记",
    }[basis] || basis
  );
}

/* ---------- errors ---------- */

function renderError(err) {
  const problems = err.payload?.problems;
  const list = problems?.length
    ? `<ul class="delta-list">${problems.map((p) => `<li><span>${esc(p.field || p.code)}</span><span class="num">${esc(p.message)}</span></li>`).join("")}</ul>`
    : "";
  bodyEl.innerHTML = `
    <div class="banner warn">
      <h3>操作未完成</h3>
      <p>${esc(err.message)}</p>
      ${list}
    </div>
    <p class="note">登记表与已有结果均未改动。</p>
  `;
  setEvidence("error", `ERROR|${err.payload?.problems?.map((p) => p.code).join(",") || "unknown"}`);
  statusEl.textContent = "操作未完成，结果区显示错误原因。";
  resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---------- actions ---------- */

async function runAnalysis() {
  setBusy(true);
  statusEl.textContent = "正在按登记营业时间逐场计算…";
  try {
    await loadState();
    renderAnalysis(await request(`/api/analysis${windowQuery()}`));
  } catch (err) {
    renderError(err);
  } finally {
    setBusy(false);
  }
}

async function runAvailability() {
  setBusy(true);
  statusEl.textContent = "正在按区间求交、求差计算可用时段分母…";
  try {
    await loadState();
    renderAvailability(await request(`/api/availability${windowQuery()}`));
  } catch (err) {
    renderError(err);
  } finally {
    setBusy(false);
  }
}

async function submitBackfill(event) {
  event.preventDefault();
  formErrorEl.hidden = true;
  const form = new FormData(formEl);
  const scope = form.get("scope");
  const kind = form.get("kind");
  const payload = {
    scope,
    kind,
    nightKey: form.get("nightKey"),
    reason: form.get("reason"),
    from: activeWindow.from,
    to: activeWindow.to,
  };
  if (scope === "stall") payload.stallId = form.get("stallId");
  if (scope === "area") payload.areaId = form.get("areaId");
  if (kind === "mirror-inferred") payload.resumeClock = form.get("resumeClock");
  else {
    payload.startClock = form.get("startClock");
    payload.endClock = form.get("endClock");
  }

  setBusy(true);
  statusEl.textContent = "正在提交补录并回查受影响班次…";
  try {
    const data = await request("/api/closures/backfill", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    await loadState();
    renderBackfill(data);
    panelEl.hidden = true;
  } catch (err) {
    setBusy(false);
    const problems = err.payload?.problems;
    formErrorEl.hidden = false;
    formErrorEl.textContent = problems?.length
      ? `${err.message}（${problems.map((p) => p.message).join("；")}）`
      : err.message;
    setEvidence("error", `ERROR|${problems?.map((p) => p.code).join(",") || "request-failed"}`);
    return;
  }
  setBusy(false);
}

/* ---------- wiring ---------- */

function wirePanel() {
  const open = $("#btn-backfill-open");
  const cancel = $("#btn-cancel-backfill");
  const scopeSelect = $("#scope-select");
  const kindSelect = $("#kind-select");

  open.addEventListener("click", () => {
    panelEl.hidden = false;
    formErrorEl.hidden = true;
    panelEl.scrollIntoView({ behavior: "smooth", block: "start" });
    $("#reason-input").focus({ preventScroll: true });
  });
  cancel.addEventListener("click", () => {
    panelEl.hidden = true;
  });
  scopeSelect.addEventListener("change", () => {
    const scope = scopeSelect.value;
    document.querySelector(".stall-field").hidden = scope !== "stall";
    document.querySelector(".area-field").hidden = scope !== "area";
  });
  kindSelect.addEventListener("change", () => {
    const mirror = kindSelect.value === "mirror-inferred";
    document.querySelector(".start-field").hidden = mirror;
    document.querySelector(".end-field").hidden = mirror;
    document.querySelector(".resume-field").hidden = !mirror;
  });
  formEl.addEventListener("submit", submitBackfill);
}

async function init() {
  wirePanel();
  $("#btn-analysis").addEventListener("click", runAnalysis);
  $("#btn-availability").addEventListener("click", runAvailability);
  $("#btn-apply-window").addEventListener("click", async () => {
    applyWindowFromInputs();
    try {
      await loadState();
      statusEl.textContent = `分析窗口已切换为 ${activeWindow.from} → ${activeWindow.to}，请选择一种分析。`;
      setEvidence("idle-window", null);
      bodyEl.innerHTML = `<p class="empty">窗口已切换为 ${esc(activeWindow.from)} → ${esc(activeWindow.to)}。点击上方任一操作重新计算。</p>`;
    } catch (err) {
      renderError(err);
    }
  });
  try {
    await loadState();
  } catch (err) {
    renderError(err);
  }
}

init();
