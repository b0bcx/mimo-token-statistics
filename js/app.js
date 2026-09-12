/* MiMo Token Statistics — frontend app */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function systemTheme() {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function readStoredDays() {
    const raw = sessionStorage.getItem("mimo-ts-days") || "";
    return raw ? raw.split(",").filter(Boolean) : [];
  }

  function readStoredHours() {
    const raw = sessionStorage.getItem("mimo-ts-hours") || "";
    return raw
      ? raw
          .split(",")
          .map((x) => Number(x))
          .filter((x) => Number.isFinite(x))
      : [];
  }

  function readRefreshSec() {
    const n = Number(localStorage.getItem("mimo-ts-refresh") || 15);
    return [5, 10, 15, 30, 60].includes(n) ? n : 15;
  }

  function readShiftMulti() {
    return localStorage.getItem("mimo-ts-shift-multi") !== "0";
  }

  function readFollowSystem() {
    // 默认跟随系统；用户关闭后写 "0"
    return localStorage.getItem("mimo-ts-follow-system") !== "0";
  }

  function persistDaySelection() {
    if (state.selectedDayDates.length) {
      sessionStorage.setItem("mimo-ts-days", state.selectedDayDates.join(","));
    } else {
      sessionStorage.removeItem("mimo-ts-days");
    }
  }

  function persistHourSelection() {
    if (state.selectedHours.length) {
      sessionStorage.setItem("mimo-ts-hours", state.selectedHours.join(","));
    } else {
      sessionStorage.removeItem("mimo-ts-hours");
    }
  }

  const state = {
    range: localStorage.getItem("mimo-ts-range") || "7",
    data: null,
    sessions: [],
    autoRefresh: true,
    refreshSec: readRefreshSec(),
    shiftMulti: readShiftMulti(),
    followSystem: readFollowSystem(),
    timer: null,
    search: "",
    sort: localStorage.getItem("mimo-ts-sort") || "last",
    modelFilter: "",
    projectFilter: "",
    sessionLimit: Number(localStorage.getItem("mimo-ts-limit") || 5),
    modelLimit: Number(localStorage.getItem("mimo-ts-model-limit") || 5),
    projectLimit: Number(localStorage.getItem("mimo-ts-project-limit") || 5),
    modelSort: localStorage.getItem("mimo-ts-model-sort") || "tokens",
    projectSort: localStorage.getItem("mimo-ts-project-sort") || "tokens",
    theme: readFollowSystem() ? systemTheme() : (localStorage.getItem("mimo-ts-theme") || systemTheme()),
    selectedDayDates: readStoredDays(),
    selectedHours: readStoredHours(),
    heatmapWeeks: [],
    hourlyDay: null,
    hourlyReqId: 0,
    hourlySig: "",
    openModel: sessionStorage.getItem("mimo-ts-open-model") || null,
    openProject: sessionStorage.getItem("mimo-ts-open-project") || null,
    // 当前列表展示所用的数据源（区间 or 选中日期）
    rankModels: null,
    rankProjects: null,
  };

  function persistOpenRanks() {
    if (state.openModel) sessionStorage.setItem("mimo-ts-open-model", state.openModel);
    else sessionStorage.removeItem("mimo-ts-open-model");
    if (state.openProject) sessionStorage.setItem("mimo-ts-open-project", state.openProject);
    else sessionStorage.removeItem("mimo-ts-open-project");
  }

  function setOpenModel(name) {
    state.openModel = name;
    persistOpenRanks();
  }

  function setOpenProject(name) {
    state.openProject = name;
    persistOpenRanks();
  }

  function currentRankModels() {
    return state.rankModels || state.data?.by_model || [];
  }

  function currentRankProjects() {
    return state.rankProjects || state.data?.by_project || [];
  }

  // softer palette, closer to rank bars / not neon
  const MODEL_COLORS = ["#ff6a00", "#5b8def", "#3a9e9e", "#8b6fc7", "#4f9e6e", "#7a8798"];

  function animateHourly(fn) {
    const el = $("#hourly-chart");
    if (!el) {
      fn?.();
      return;
    }
    el.classList.add("animate");
    try {
      fn?.();
    } finally {
      setTimeout(() => el.classList.remove("animate"), 620);
    }
  }

  // ── utils ─────────────────────────────────────────────────
  function formatTok(n) {
    n = Number(n) || 0;
    if (!n) return "0";
    if (n >= 1e8) {
      let s = (n / 1e8).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
      return s + "亿";
    }
    if (n >= 1e4) {
      let s = (n / 1e4).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
      return s + "万";
    }
    return n.toLocaleString("zh-CN");
  }

  function exact(n) {
    return (Number(n) || 0).toLocaleString("zh-CN");
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function debounce(fn, ms = 200) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function shortPath(p) {
    if (!p) return "";
    const parts = String(p).replace(/[\\/]+$/, "").split(/[\\/]/);
    if (parts.length <= 2) return p;
    return "…/" + parts.slice(-2).join("/");
  }

  function heatLevel(pct) {
    if (!pct || pct <= 0) return 0;
    if (pct <= 15) return 1;
    if (pct <= 35) return 2;
    if (pct <= 65) return 3;
    return 4;
  }

  // ── theme ─────────────────────────────────────────────────
  function applyTheme() {
    document.documentElement.setAttribute("data-theme", state.theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      "content",
      state.theme === "light" ? "#f3f5f8" : "#0b1017"
    );
  }

  function toggleTheme() {
    // 跟随系统开启时，手动切换会关闭跟随并记住手动主题
    if (state.followSystem) {
      state.followSystem = false;
      localStorage.setItem("mimo-ts-follow-system", "0");
      syncSettingsControls();
    }
    state.theme = state.theme === "light" ? "dark" : "light";
    localStorage.setItem("mimo-ts-theme", state.theme);
    applyTheme();
  }

  // 主题跟随系统变化
  try {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
      if (!state.followSystem) return;
      state.theme = e.matches ? "dark" : "light";
      applyTheme();
    });
  } catch (_) {}

  // 断点切换（手机横竖屏等）后，按实际格宽重排月份标签
  window.addEventListener(
    "resize",
    debounce(() => {
      if (state.heatmapWeeks?.length) layoutHeatmapMonths(state.heatmapWeeks);
    }, 120)
  );

  // ── API ───────────────────────────────────────────────────
  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "no-store", credentials: "same-origin" });
    if (res.status === 401) {
      if (!location.pathname.startsWith("/login")) location.href = "/login";
      throw new Error("需要登录");
    }
    if (!res.ok) {
      let msg = "HTTP " + res.status;
      try {
        const j = await res.json();
        if (j.error) msg = j.error;
      } catch (_) {}
      throw new Error(msg);
    }
    return res.json();
  }

  async function loadOverview() {
    const btn = $("#btn-refresh");
    if (btn) btn.disabled = true;
    try {
      const data = await fetchJSON(`/api/overview?range=${encodeURIComponent(state.range)}`);
      state.data = data;
      if (data.ok) {
        state.sessions = data.by_session || [];
        renderAll(data);
        hideBanner();
      } else {
        showBanner(data.error || "加载失败", true);
      }
    } catch (err) {
      showBanner("无法连接统计服务：" + err.message + "。请确认 server.py 正在运行。", true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // 预取其它时间范围，减少点击后的等待
  async function prefetchRanges() {
    // 先预热最重的 all，再其它轻量范围
    if (state.range !== "all") {
      try {
        await fetch(`/api/overview?range=all`, { cache: "no-store", credentials: "same-origin" });
      } catch (_) {}
    }
    const light = ["7", "14", "30", "today", "90"].filter((r) => r !== state.range);
    for (const r of light) {
      try {
        await fetch(`/api/overview?range=${r}`, { cache: "no-store", credentials: "same-origin" });
      } catch (_) {}
    }
  }

  async function loadHealth() {
    try {
      const h = await fetchJSON("/api/health");
      const dbEl = $("#footer-db");
      if (h.ok && dbEl) {
        dbEl.textContent = `DB ${exact(h.messages)} 条消息 · ${exact(h.sessions)} 个会话`;
      }
    } catch (_) {}
  }

  function showBanner(msg, isError = false) {
    const el = $("#status-banner");
    if (!el) return;
    el.hidden = false;
    el.classList.toggle("error", isError);
    el.textContent = msg;
  }

  function hideBanner() {
    const el = $("#status-banner");
    if (el) el.hidden = true;
  }

  // ── tooltip / hover card ──────────────────────────────────
  function showTooltip(ev, html) {
    const tip = $("#chart-tooltip");
    if (!tip) return;
    tip.hidden = false;
    tip.innerHTML = html;
    tip.style.transform = "none";

    const rect = tip.getBoundingClientRect();
    const pad = 12;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 默认在指针上方水平居中；靠边时向内收，避免被视口裁切
    let left = ev.clientX - rect.width / 2;
    if (left + rect.width > vw - pad) left = vw - pad - rect.width;
    if (left < pad) left = pad;

    let top = ev.clientY - rect.height - 10;
    if (top < pad) top = Math.min(ev.clientY + 16, vh - rect.height - pad);

    tip.style.left = Math.round(left) + "px";
    tip.style.top = Math.round(Math.max(pad, top)) + "px";
  }

  function hideTooltip() {
    const tip = $("#chart-tooltip");
    if (tip) tip.hidden = true;
  }

  function showHoverCard(ev, html) {
    const card = $("#hover-card");
    if (!card) return;
    card.hidden = false;
    card.innerHTML = html;
    const rect = card.getBoundingClientRect();
    let x = ev.clientX + 14;
    let y = ev.clientY + 10;
    if (x + rect.width > window.innerWidth - 8) x = ev.clientX - rect.width - 10;
    if (y + rect.height > window.innerHeight - 8) y = ev.clientY - rect.height - 10;
    card.style.left = Math.max(8, x) + "px";
    card.style.top = Math.max(8, y) + "px";
  }

  function hideHoverCard() {
    const card = $("#hover-card");
    if (card) card.hidden = true;
  }

  // ── render root ───────────────────────────────────────────
  function renderAll(data) {
    renderKPI(data);
    renderDailyChart(data);
    // 已选中日历时，时段活跃 / 排行由选中日期驱动，避免自动刷新时闪回区间汇总
    if (!state.selectedDayDates.length) {
      animateHourly(() => renderHourly(data));
      const hsub0 = $("#hourly-sub");
      if (hsub0) hsub0.textContent = `${data.range_label || ""} · 按小时`;
      renderModels(data.by_model || []);
      renderProjects(data.by_project || []);
      populateModelFilter(data);
      state.sessions = data.by_session || [];
      renderSessions();
      const msub0 = $("#models-sub");
      const psub0 = $("#projects-sub");
      const ssub0 = $("#sessions-sub");
      if (msub0) msub0.textContent = data.range_label || "";
      if (psub0) psub0.textContent = data.range_label || "";
      if (ssub0) ssub0.textContent = data.range_label || "";
    }
    renderInsights(data);

    const sub = $("#chart-sub");
    if (sub) sub.textContent = `最近 ${data.heat_days || data.chart_days} 天`;

    const ft = $("#footer-time");
    if (ft) {
      ft.textContent = "更新于 " + new Date(data.generated_at).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    }
  }

  function renderKPI(data) {
    const t = data.totals || {};
    const set = (id, text) => {
      const el = $(id);
      if (el) el.textContent = text;
    };
    set("#kpi-today", formatTok(t.today));
    set("#kpi-today-meta", `${exact(t.today)} tokens`);
    set("#kpi-total", t.fmt || formatTok(t.tokens));
    set("#kpi-total-meta", `${exact(t.tokens)} tokens · 日均 ${t.avg_daily_fmt}`);
    set("#kpi-turns", exact(t.turns));
    set("#kpi-turns-meta", `${t.sessions || 0} 会话 · 次均 ${t.avg_per_turn_fmt}`);
    set("#kpi-cache", (t.cache_hit ?? 0) + "%");
    set("#kpi-cache-meta", `入 ${formatTok(t.input)} · 出 ${formatTok(t.output)} · 缓存 ${formatTok(t.cache)}`);
  }

  // ── daily calendar heatmap ────────────────────────────────
  function layoutHeatmapMonths(weeks) {
    const el = $("#heatmap-grid");
    const monthsEl = $("#heatmap-months");
    if (!el || !monthsEl || !weeks?.length) return;
    const cs = getComputedStyle(el);
    const heatGap = parseFloat(cs.columnGap || cs.gap) || 0;
    const heatCellRaw = cs.gridAutoColumns;
    const heatCellW =
      parseFloat(heatCellRaw) ||
      el.querySelector(".hm-cell")?.getBoundingClientRect().width ||
      16;
    const cellPitch = heatCellW + heatGap;
    const monthNames = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
    let mHtml = "";
    let wi = 0;
    let lastMo = -1;
    weeks.forEach((week) => {
      const first = week.find((d) => d);
      if (first) {
        const mo = Number(first.date.slice(5, 7)) - 1;
        if (mo !== lastMo) {
          lastMo = mo;
          mHtml += `<span style="left:${wi * cellPitch}px">${monthNames[mo]}</span>`;
        }
      }
      wi += 1;
    });
    monthsEl.innerHTML = mHtml;
    monthsEl.style.width = `${Math.max(0, weeks.length * cellPitch - heatGap)}px`;
  }

  function renderDailyChart(data) {
    const el = $("#heatmap-grid");
    const empty = $("#chart-empty");
    if (!el) return;
    const weeks = data.heatmap_weeks || [];
    const hasAny = weeks.some((w) => w.some((d) => d && d.tokens > 0));
    if (!weeks.length || !hasAny) {
      el.innerHTML = "";
      state.heatmapWeeks = [];
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    state.heatmapWeeks = weeks;

    const heatDaysFlat = [];
    let html = "";
    let lastMonth = -1;

    weeks.forEach((week) => {
      week.forEach((d) => {
        if (!d) {
          html += `<div class="hm-cell blank" aria-hidden="true"></div>`;
          return;
        }
        heatDaysFlat.push(d);
        const lvl = heatLevel(d.pct);
        const cls = [
          "hm-cell",
          `hm-l${lvl}`,
          d.tokens > 0 ? "has-data" : "",
          d.is_today ? "today" : "",
          state.selectedDayDates.includes(d.date) ? "selected" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const tip = `${d.date} · ${exact(d.tokens)} tokens · ${d.turns} 轮`;
        html += `<button type="button" class="${cls}" data-date="${d.date}" aria-label="${escapeHtml(tip)}"></button>`;
      });
    });
    el.innerHTML = html;
    layoutHeatmapMonths(weeks);

    // 窄屏时默认露出最近日期（今天）
    const scrollBox = el.closest(".heatmap-scroll");
    if (scrollBox) {
      scrollBox.scrollLeft = scrollBox.scrollWidth;
    }

    el.querySelectorAll(".hm-cell").forEach((cell) => {
      if (cell.classList.contains("blank")) return;
      const d = heatDaysFlat.find((x) => x.date === cell.dataset.date);
      const tipHtml = () => {
        if (!d) return "";
        const models = (d.models || []).slice(0, 3);
        return `
          <div class="tt-title">${escapeHtml(d.date)}${d.is_today ? " · 今天" : ""}</div>
          <div class="tt-row"><span>消耗</span><strong>${formatTok(d.tokens)}（${exact(d.tokens)}）</strong></div>
          <div class="tt-row"><span>请求 / 次均</span><strong>${exact(d.turns)} 次/${d.avg_fmt || formatTok(d.turns ? d.tokens / d.turns : 0)}</strong></div>
          <div class="tt-row"><span>入/出/缓存</span><strong>${formatTok(d.input)} / ${formatTok(d.output)} / ${formatTok(d.cache)}</strong></div>
          <div class="tt-row"><span>命中率</span><strong>${d.cache_hit ?? 0}%</strong></div>
          ${models.map((m) => `<div class="tt-row"><span>${escapeHtml(m.model)}</span><strong>${m.share}%</strong></div>`).join("")}`;
      };
      cell.addEventListener("mousemove", (ev) => showTooltip(ev, tipHtml()));
      cell.addEventListener("mouseenter", (ev) => showTooltip(ev, tipHtml()));
      cell.addEventListener("mouseleave", hideTooltip);
      cell.addEventListener("click", (ev) => {
        if (!d) return;
        ev.preventDefault();
        ev.stopPropagation();
        try { window.getSelection()?.removeAllRanges(); } catch (_) {}
        const list = state.selectedDayDates.slice();
        if (ev.shiftKey && state.shiftMulti) {
          const idx = list.indexOf(d.date);
          if (idx >= 0) list.splice(idx, 1);
          else list.push(d.date);
          list.sort();
          state.selectedDayDates = list;
          persistDaySelection();
          el.querySelectorAll(".hm-cell").forEach((c) =>
            c.classList.toggle("selected", state.selectedDayDates.includes(c.dataset.date))
          );
          if (!list.length) closeDayDetail();
          else applyDaySelection();
          return;
        }
        // 普通点击：单选 / 再点取消
        if (list.length === 1 && list[0] === d.date) {
          closeDayDetail();
          return;
        }
        state.selectedDayDates = [d.date];
        persistDaySelection();
        el.querySelectorAll(".hm-cell").forEach((c) =>
          c.classList.toggle("selected", c.dataset.date === d.date)
        );
        applyDaySelection();
      });
    });

    if (state.selectedDayDates.length) {
      applyDaySelection();
    }
  }

  function selectedDayObjects(heatDaysFlat) {
    return state.selectedDayDates
      .map((date) => heatDaysFlat.find((d) => d.date === date))
      .filter(Boolean);
  }

  function modelDetailHoverHtml(d) {
    const tokens = Number(d.tokens) || 0;
    const share = Number(d.share) || 0;
    const turns = Number(d.turns) || 0;
    return `
      <div class="hc-title">${escapeHtml(d.model || "")}</div>
      <div class="hc-row"><span>消耗</span><strong>${formatTok(tokens)}（${exact(tokens)}）</strong></div>
      <div class="hc-row"><span>占比</span><strong>${share}%</strong></div>
      ${turns ? `<div class="hc-row"><span>请求 / 次均</span><strong>${exact(turns)} 次/${formatTok(tokens / turns)}</strong></div>` : ""}
      <div class="hc-row"><span>入/出/缓存</span><strong>${formatTok(Number(d.input) || 0)} / ${formatTok(Number(d.output) || 0)} / ${formatTok(Number(d.cache) || 0)}</strong></div>
      <div class="hc-row"><span>命中率</span><strong>${Number(d.cache_hit) || 0}%</strong></div>`;
  }

  function bindDayDetailHover(root) {
    root.querySelectorAll("[data-model]").forEach((row) => {
      const payload = {
        model: row.dataset.model,
        tokens: row.dataset.tokens,
        share: row.dataset.share,
        turns: row.dataset.turns,
        input: row.dataset.input,
        output: row.dataset.output,
        cache: row.dataset.cache,
        cache_hit: row.dataset.cacheHit,
      };
      const html = modelDetailHoverHtml(payload);
      row.addEventListener("mousemove", (ev) => showHoverCard(ev, html));
      row.addEventListener("mouseenter", (ev) => showHoverCard(ev, html));
      row.addEventListener("mouseleave", hideHoverCard);
    });
  }

  function renderDayDetailPanel(payload, title) {
    const box = $("#day-detail");
    if (!box) return;
    openDetailPanel(box);
    const dateEl = $("#day-detail-date");
    const statsEl = $("#day-detail-stats");
    if (dateEl) dateEl.textContent = title;
    if (statsEl) {
      const avg = payload.avg_fmt || formatTok(payload.turns ? payload.tokens / payload.turns : 0);
      statsEl.innerHTML = `
        <div class="ss-row">
          <div class="ss-item"><span class="ss-l">消耗</span><span class="ss-v">${escapeHtml(payload.fmt || formatTok(payload.tokens))}</span><span class="ss-x">${exact(payload.tokens)}</span></div>
          <div class="ss-item"><span class="ss-l">请求</span><span class="ss-v">${exact(payload.turns)}</span></div>
          <div class="ss-item"><span class="ss-l">次均</span><span class="ss-v">${escapeHtml(avg)}</span></div>
          <div class="ss-item"><span class="ss-l">命中率</span><span class="ss-v">${payload.cache_hit ?? 0}%</span></div>
        </div>
        <div class="ss-io"><span>入 ${formatTok(payload.input)}</span><span>出 ${formatTok(payload.output)}</span><span>缓存 ${formatTok(payload.cache)}</span></div>`;
    }
    const modelsEl = $("#day-detail-models");
    if (!modelsEl) return;
    const models = payload.models || [];
    if (!models.length) {
      modelsEl.innerHTML = `<div style="color:var(--text-3);font-size:12px">无消耗</div>`;
      return;
    }
    modelsEl.innerHTML = models
      .map((m, i) =>
        rankRow({
          name: m.model,
          meta: `${formatTok(m.tokens)} · ${m.share}%`,
          pct: m.share,
          fillClass: `model-${i % 4}`,
          dataAttrs: `data-model="${escapeHtml(m.model)}" data-tokens="${m.tokens}" data-share="${m.share}" data-turns="${m.turns || 0}" data-input="${m.input || 0}" data-output="${m.output || 0}" data-cache="${m.cache || 0}" data-cache-hit="${m.cache_hit || 0}"`,
        })
      )
      .join("");
    bindDayDetailHover(modelsEl);
  }

  function applyDaySelection() {
    const dates = state.selectedDayDates.slice();
    if (!dates.length) {
      closeDayDetail();
      return;
    }
    syncDaysDetail(dates);
  }

  function selectionLabel(dates) {
    if (dates.length === 1) return dates[0];
    if (dates.length <= 3) return dates.join(", ");
    return `${dates[0]} … ${dates[dates.length - 1]} · ${dates.length} 天`;
  }

  function restoreRangeRanks() {
    const data = state.data;
    if (!data) return;
    renderModels(data.by_model || []);
    renderProjects(data.by_project || []);
    populateModelFilter(data);
    state.sessions = data.by_session || [];
    renderSessions();
    const msub = $("#models-sub");
    const psub = $("#projects-sub");
    const ssub = $("#sessions-sub");
    if (msub) msub.textContent = data.range_label || "";
    if (psub) psub.textContent = data.range_label || "";
    if (ssub) ssub.textContent = data.range_label || "";
  }

  function applySelectedDayRanks(d) {
    const label = selectionLabel(state.selectedDayDates);
    renderModels(d.by_model || []);
    renderProjects(d.by_project || []);
    populateModelFilter({ by_model: d.by_model || [], by_project: d.by_project || [] });
    state.sessions = d.by_session || [];
    renderSessions();
    const msub = $("#models-sub");
    const psub = $("#projects-sub");
    const ssub = $("#sessions-sub");
    if (msub) msub.textContent = label;
    if (psub) psub.textContent = label;
    if (ssub) ssub.textContent = label;
  }

  async function syncDaysDetail(dates) {
    const box = $("#day-detail");
    openDetailPanel(box);
    const dateEl = $("#day-detail-date");
    const statsEl = $("#day-detail-stats");
    const modelsEl = $("#day-detail-models");
    const label = selectionLabel(dates);
    if (dateEl) dateEl.textContent = dates.length === 1 ? dates[0] : `${dates.join(", ")} · ${dates.length} 天`;
    if (statsEl) statsEl.innerHTML = `<div style="color:var(--text-3);font-size:12px">汇总中…</div>`;
    if (modelsEl) modelsEl.innerHTML = "";
    const reqId = ++state.hourlyReqId;
    try {
      const d = await fetchJSON(`/api/days-hourly?dates=${encodeURIComponent(dates.join(","))}`);
      if (reqId !== state.hourlyReqId || JSON.stringify(state.selectedDayDates) !== JSON.stringify(dates)) return;
      if (!d.ok) return;
      renderDayDetailPanel(
        {
          tokens: d.tokens || d.total,
          fmt: d.total_fmt,
          turns: d.turns,
          avg_fmt: d.avg_fmt,
          cache_hit: d.cache_hit,
          input: d.input,
          output: d.output,
          cache: d.cache,
          models: d.models,
        },
        dates.length === 1 ? dates[0] : `${dates.join(", ")} · ${dates.length} 天`
      );
      const hsub = $("#hourly-sub");
      if (hsub) hsub.textContent = `${label} · 按小时`;
      animateHourly(() =>
        renderHourly({
          hourly: d.hourly || [],
          hourly_models: d.hourly_models || [],
          insights: {
            peak_hour:
              d.peak_hour != null
                ? { hour: d.peak_hour, fmt: formatTokenFromHour(d.hourly, d.peak_hour) }
                : null,
          },
        })
      );
      // 模型 / 项目 / 会话跟随选中日期
      applySelectedDayRanks(d);
    } catch (_) {}
  }

  function openDetailPanel(box) {
    if (!box) return;
    box.hidden = false;
    box.classList.add("open");
  }

  function closeDetailPanel(box) {
    if (!box) return;
    box.classList.remove("open");
    box.hidden = true;
  }

  function closeDayDetail() {
    state.selectedDayDates = [];
    persistDaySelection();
    const box = $("#day-detail");
    closeDetailPanel(box);
    $$(".hm-cell.selected").forEach((c) => c.classList.remove("selected"));
    restoreRangeRanks();
    syncHourlyForDays(null);
  }

  async function syncHourlyForDays(dates) {
    const base = state.data;
    const hsub = $("#hourly-sub");
    const reqId = ++state.hourlyReqId;
    const el = $("#hourly-chart");
    if (el) el.classList.add("animate");
    const key = dates && dates.length ? dates.join(",") : "";
    state.hourlyDay = key || null;

    if (!key) {
      if (base) {
        animateHourly(() => renderHourly(base));
        if (hsub) hsub.textContent = `${base.range_label || ""} · 按小时`;
      }
      return;
    }
    if (hsub) {
      hsub.textContent =
        dates.length === 1 ? `${dates[0]} · 按小时` : `${dates.join(", ")} · 按小时`;
    }
    try {
      const url =
        dates.length === 1
          ? `/api/day-hourly?date=${encodeURIComponent(dates[0])}`
          : `/api/days-hourly?dates=${encodeURIComponent(dates.join(","))}`;
      const d = await fetchJSON(url);
      if (reqId !== state.hourlyReqId || (state.selectedDayDates.join(",") || "") !== key) return;
      if (!d.ok) {
        if (base) renderHourly(base);
        return;
      }
      animateHourly(() =>
        renderHourly({
          hourly: d.hourly || [],
          hourly_models: d.hourly_models || [],
          insights: {
            peak_hour:
              d.peak_hour != null
                ? {
                    hour: d.peak_hour,
                    fmt: formatTokenFromHour(d.hourly, d.peak_hour),
                  }
                : null,
          },
        })
      );
    } catch (_) {
      if (reqId === state.hourlyReqId && base) renderHourly(base);
    } finally {
      setTimeout(() => el?.classList.remove("animate"), 620);
    }
  }

  function formatTokenFromHour(hours, hour) {
    const h = (hours || []).find((x) => x.hour === hour);
    return h?.fmt || "0";
  }

  // ── hourly stacked bars by model ──────────────────────────
  let hourlyCache = { hours: [], models: [], peakHour: null };

  function buildHourlyShell(el, hours, modelNames, peakHour) {
    el.innerHTML = hours
      .map((h) => {
        const selected = state.selectedHours.includes(h.hour) ? " selected" : "";
        const peak = h.hour === peakHour ? " peak" : "";
        return `
          <div class="hour-col${peak}${selected}" tabindex="0" data-hour="${h.hour}" style="--i:${h.hour}">
            <div class="hour-bar-area">
              <div class="hour-bars" style="height:0%"></div>
            </div>
            <div class="hour-label">${h.hour}</div>
          </div>`;
      })
      .join("");

    const tipHtml = (h) => {
      const item = hourlyCache.hours.find((x) => x.hour === h);
      if (!item) return "";
      const stacks = (item.stacks || []).filter((s) => s.tokens > 0).slice(0, 5);
      const sum = stacks.reduce((a, s) => a + s.tokens, 0) || 1;
      const tin = stacks.reduce((a, s) => a + (s.input || 0), 0);
      const tout = stacks.reduce((a, s) => a + (s.output || 0), 0);
      const tcache = stacks.reduce((a, s) => a + (s.cache || 0), 0);
      return `
        <div class="tt-title">${String(h).padStart(2, "0")}:00</div>
        <div class="tt-row"><span>消耗</span><strong>${formatTok(item.tokens)}（${exact(item.tokens)}）</strong></div>
        <div class="tt-row"><span>请求 / 次均</span><strong>${exact(item.turns)} 次/${item.avg_fmt || formatTok(item.turns ? item.tokens / item.turns : 0)}</strong></div>
        <div class="tt-row"><span>入/出/缓存</span><strong>${formatTok(tin)} / ${formatTok(tout)} / ${formatTok(tcache)}</strong></div>
        <div class="tt-row"><span>命中率</span><strong>${item.cache_hit ?? 0}%</strong></div>
        ${stacks
          .map(
            (s) =>
              `<div class="tt-row"><span>${escapeHtml(s.model)}</span><strong>${round1((s.tokens / sum) * 100)}%</strong></div>`
          )
          .join("")}`;
    };

    el.querySelectorAll(".hour-col").forEach((col) => {
      const h = Number(col.dataset.hour);
      const show = (ev) => showTooltip(ev, tipHtml(h));
      col.addEventListener("mousemove", show);
      col.addEventListener("mouseenter", show);
      col.addEventListener("mouseleave", hideTooltip);
      const toggleHour = (ev) => {
        if (ev) {
          ev.preventDefault?.();
          try { window.getSelection()?.removeAllRanges(); } catch (_) {}
        }
        const list = state.selectedHours.slice();
        if (ev && ev.shiftKey && state.shiftMulti) {
          const idx = list.indexOf(h);
          if (idx >= 0) list.splice(idx, 1);
          else list.push(h);
          list.sort((a, b) => a - b);
          state.selectedHours = list;
          persistHourSelection();
          el.querySelectorAll(".hour-col").forEach((c) =>
            c.classList.toggle("selected", state.selectedHours.includes(Number(c.dataset.hour)))
          );
          if (!list.length) closeHourDetail();
          else applyHourSelection();
          return;
        }
        if (list.length === 1 && list[0] === h) {
          closeHourDetail();
          return;
        }
        state.selectedHours = [h];
        persistHourSelection();
        el.querySelectorAll(".hour-col").forEach((c) =>
          c.classList.toggle("selected", Number(c.dataset.hour) === h)
        );
        const item = hourlyCache.hours.find((x) => x.hour === h);
        showHourDetail(item, h);
      };
      col.addEventListener("click", (ev) => toggleHour(ev));
      col.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleHour(e);
        }
      });
    });
  }

  function applyHourSelection() {
    const list = state.selectedHours;
    if (!list.length) {
      closeHourDetail();
      return;
    }
    if (list.length === 1) {
      const item = hourlyCache.hours.find((x) => x.hour === list[0]);
      showHourDetail(item, list[0]);
      return;
    }
    // 多选：合并所选小时
    const picked = list
      .map((h) => hourlyCache.hours.find((x) => x.hour === h))
      .filter(Boolean);
    if (!picked.length) {
      closeHourDetail();
      return;
    }
    const tokens = picked.reduce((a, x) => a + x.tokens, 0);
    const turns = picked.reduce((a, x) => a + x.turns, 0);
    const input = picked.reduce((a, x) => a + (x.input || 0), 0);
    const output = picked.reduce((a, x) => a + (x.output || 0), 0);
    const cache = picked.reduce((a, x) => a + (x.cache || 0), 0);
    const cr = picked.reduce((a, x) => a + (x.cache_read || 0), 0);
    const cw = picked.reduce((a, x) => a + (x.cache_write || 0), 0);
    const modelMap = new Map();
    picked.forEach((x) => {
      (x.stacks || []).forEach((s) => {
        if (!s.tokens) return;
        const cur = modelMap.get(s.model) || {
          model: s.model,
          tokens: 0,
          turns: 0,
          input: 0,
          output: 0,
          cache: 0,
          cache_read: 0,
          cache_write: 0,
        };
        cur.tokens += s.tokens;
        cur.turns += s.turns || 0;
        cur.input += s.input || 0;
        cur.output += s.output || 0;
        cur.cache += s.cache || 0;
        cur.cache_read += s.cache_read || 0;
        cur.cache_write += s.cache_write || 0;
        modelMap.set(s.model, cur);
      });
    });
    const models = [...modelMap.values()]
      .sort((a, b) => b.tokens - a.tokens)
      .map((m) => ({
        ...m,
        share: tokens ? round1((m.tokens / tokens) * 100) : 0,
        cache_hit: m.cache_read + m.cache_write + m.input > 0
          ? Math.round((m.cache_read / (m.cache_read + m.cache_write + m.input)) * 100)
          : 0,
      }));
    showHourDetail(
      {
        tokens,
        turns,
        input,
        output,
        cache,
        cache_hit: cr + cw + input > 0 ? Math.round((cr / (cr + cw + input)) * 100) : 0,
        avg_fmt: formatTok(turns ? tokens / turns : 0),
        stacks: models,
      },
      list[0],
      list[list.length - 1],
      list.length
    );
  }

  function paintHourlyBars(el, hours, peakHour) {
    const max = Math.max(...hours.map((h) => h.tokens), 0);
    el.querySelectorAll(".hour-col").forEach((col) => {
      const h = Number(col.dataset.hour);
      const item = hours.find((x) => x.hour === h);
      if (!item) return;
      const bars = col.querySelector(".hour-bars");
      if (!bars) return;
      const hPct = max ? Math.max(item.tokens > 0 ? 3 : 0, (item.tokens / max) * 100) : 0;
      const stacks = (item.stacks || []).filter((s) => s.tokens > 0);
      const totalStack = stacks.reduce((a, s) => a + (s.tokens || 0), 0) || 1;
      const need = Math.max(stacks.length, bars.children.length);

      // 固定段槽位，高度用 0 过渡，避免 innerHTML 重建闪烁
      while (bars.children.length < need) {
        const div = document.createElement("div");
        div.className = "hour-seg";
        div.style.height = "0%";
        bars.appendChild(div);
      }
      for (let i = 0; i < bars.children.length; i++) {
        const node = bars.children[i];
        const s = stacks[i];
        const color = MODEL_COLORS[i % MODEL_COLORS.length];
        node.style.background = color;
        node.style.height = s ? `${((s.tokens || 0) / totalStack) * 100}%` : "0%";
      }
      bars.style.height = `${hPct}%`;
      col.classList.toggle("peak", item.hour === peakHour);
      col.classList.toggle("selected", state.selectedHours.includes(h));
    });
  }

  function renderHourly(data) {
    const el = $("#hourly-chart");
    if (!el) return;
    const hours = data.hourly || [];
    const modelNames = data.hourly_models || [];
    const peakHour = data.insights?.peak_hour?.hour ?? null;
    hourlyCache = { hours, models: modelNames, peakHour };

    const legend = $("#hour-legend");
    if (legend) {
      const sig = modelNames.join("|");
      if (legend.dataset.sig !== sig) {
        legend.innerHTML = modelNames
          .map((name, i) => {
            const color = MODEL_COLORS[i % MODEL_COLORS.length];
            return `<span class="leg"><i class="sw" style="background:${color}"></i>${escapeHtml(name)}</span>`;
          })
          .join("");
        legend.dataset.sig = sig;
      }
    }

    // 只在首次建 24 列骨架；之后永不重建，避免切范围/日期时整表闪烁
    if (el.children.length !== hours.length) {
      buildHourlyShell(el, hours, modelNames, peakHour);
      state.hourlySig = `shell:${hours.length}`;
    }
    paintHourlyBars(el, hours, peakHour);

    if (state.selectedHours.length) {
      applyHourSelection();
    } else {
      const box = $("#hour-detail");
      if (box && !box.hidden) closeHourDetail();
    }

    const chip = $("#peak-hour-chip");
    if (chip) {
      chip.textContent =
        peakHour != null
          ? `高峰 ${String(peakHour).padStart(2, "0")}:00 · ${formatTokenFromHour(hours, peakHour)}`
          : "暂无高峰";
    }
  }

  function showHourDetail(h, hour, hourEnd = null, count = 1) {
    const box = $("#hour-detail");
    if (!box || !h) return;
    openDetailPanel(box);
    const dateEl = $("#hour-detail-date");
    const statsEl = $("#hour-detail-stats");
    if (dateEl) {
      if (hourEnd != null && count > 1) {
        const hours = state.selectedHours.map((x) => String(x).padStart(2, "0"));
        dateEl.textContent = `${hours.join(", ")} 点 · ${count} 个时段`;
      } else {
        dateEl.textContent = `${String(hour).padStart(2, "0")}:00–${String(hour).padStart(2, "0")}:59`;
      }
    }
    if (statsEl) {
      const avg = h.avg_fmt || formatTok(h.turns ? h.tokens / h.turns : 0);
      statsEl.innerHTML = `
        <div class="ss-row">
          <div class="ss-item"><span class="ss-l">消耗</span><span class="ss-v">${formatTok(h.tokens)}</span><span class="ss-x">${exact(h.tokens)}</span></div>
          <div class="ss-item"><span class="ss-l">请求</span><span class="ss-v">${exact(h.turns)}</span></div>
          <div class="ss-item"><span class="ss-l">次均</span><span class="ss-v">${escapeHtml(avg)}</span></div>
          <div class="ss-item"><span class="ss-l">命中率</span><span class="ss-v">${h.cache_hit ?? 0}%</span></div>
        </div>
        <div class="ss-io"><span>入 ${formatTok(h.input || 0)}</span><span>出 ${formatTok(h.output || 0)}</span><span>缓存 ${formatTok(h.cache || 0)}</span></div>`;
    }
    const modelsEl = $("#hour-detail-models");
    if (!modelsEl) return;
    const stacks = (h.stacks || []).filter((s) => s.tokens > 0);
    if (!stacks.length) {
      modelsEl.innerHTML = `<div style="color:var(--text-3);font-size:12px">该时段无消耗</div>`;
      return;
    }
    const max = stacks[0].tokens || 1;
    const sum = stacks.reduce((a, s) => a + s.tokens, 0) || 1;
    modelsEl.innerHTML = stacks
      .map((s, i) => {
        const share = round1((s.tokens / sum) * 100);
        return rankRow({
          name: s.model,
          meta: `${formatTok(s.tokens)} · ${share}%`,
          pct: share,
          fillClass: `model-${i % 4}`,
          dataAttrs: `data-model="${escapeHtml(s.model)}" data-tokens="${s.tokens}" data-share="${share}" data-turns="${s.turns || 0}" data-input="${s.input || 0}" data-output="${s.output || 0}" data-cache="${s.cache || 0}" data-cache-hit="${s.cache_hit || 0}"`,
        });
      })
      .join("");
    bindDayDetailHover(modelsEl);
  }

  function closeHourDetail() {
    state.selectedHours = [];
    persistHourSelection();
    const box = $("#hour-detail");
    closeDetailPanel(box);
    $$(".hour-col.selected").forEach((c) => c.classList.remove("selected"));
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  // ── rank rows ─────────────────────────────────────────────
  function rankRow({ name, meta, pct, sub, fillClass = "", id = "", kind = "", open = false, detail = "", dataAttrs = "" }) {
    // meta: "6.91亿 · 72.1%" → 消耗加粗、占比弱化
    let metaHtml = escapeHtml(meta || "");
    const m = (meta || "").match(/^(.*?)( · )([\d.]+%)(.*)$/);
    if (m) {
      metaHtml = `<strong>${escapeHtml(m[1])}</strong>${m[2]}${escapeHtml(m[3])}${escapeHtml(m[4] || "")}`;
    }
    return `
      <div class="rank-row${open ? " open" : ""}" data-id="${escapeHtml(id)}" data-kind="${kind}" data-name="${escapeHtml(name)}" ${dataAttrs} tabindex="0" role="button">
        <div class="rank-top">
          <div class="rank-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
          <div class="rank-meta">${metaHtml}</div>
        </div>
        <div class="rank-bar"><div class="rank-fill ${fillClass}" style="width:${Math.max(1, Math.min(100, pct || 0))}%"></div></div>
        ${sub ? `<div class="rank-sub" title="${escapeHtml(sub)}">${escapeHtml(sub)}</div>` : ""}
        ${detail}
      </div>`;
  }

  function formatShare(p) {
    const n = Number(p) || 0;
    return n >= 10 ? `${n.toFixed(1).replace(/\.0$/, "")}%` : `${n.toFixed(1)}%`;
  }

  function sortRankItems(list, mode, tokensKey = "tokens") {
    const arr = list.slice();
    const num = (x, k) => Number(x?.[k]) || 0;
    switch (mode) {
      case "last":
        arr.sort((a, b) => num(b, "last") - num(a, "last"));
        break;
      case "turns":
        arr.sort((a, b) => num(b, "turns") - num(a, "turns"));
        break;
      case "avg":
        arr.sort((a, b) => num(b, "avg") - num(a, "avg"));
        break;
      case "input":
        arr.sort((a, b) => num(b, "input") - num(a, "input"));
        break;
      case "output":
        arr.sort((a, b) => num(b, "output") - num(a, "output"));
        break;
      case "cache":
        arr.sort((a, b) => num(b, "cache") - num(a, "cache"));
        break;
      case "hit":
        arr.sort((a, b) => num(b, "cache_hit") - num(a, "cache_hit"));
        break;
      default:
        arr.sort((a, b) => num(b, tokensKey) - num(a, tokensKey));
    }
    return arr;
  }

  function renderModels(models) {
    const el = $("#model-list");
    if (!el) return;
    state.rankModels = models;
    if (!models.length) {
      el.innerHTML = `<div style="color:var(--text-3);font-size:12px;padding:16px 0">暂无数据</div>`;
      return;
    }
    const sorted = sortRankItems(models, state.modelSort);
    const limit = state.modelLimit > 0 ? state.modelLimit : sorted.length;
    el.innerHTML = sorted
      .slice(0, limit)
      .map((m, i) => {
        const open = state.openModel === m.model;
        return rankRow({
          name: m.model,
          meta: `${m.fmt} · ${formatShare(m.share)} · 命中 ${m.cache_hit}%`,
          pct: m.share,
          sub: `${m.turns} 次/${m.avg_fmt}`,
          fillClass: `model-${i % 4}`,
          id: m.model,
          kind: "model",
          open,
          detail: open ? renderModelDetail(m) : "",
        });
      })
      .join("");

    bindRankEvents(el, "model", models);
  }

  function renderModelDetail(m) {
    const sessions = m.top_sessions || [];
    const turns = m.turns || 0;
    return `
      <div class="rank-detail">
        <div class="rank-detail-head">
          <span class="rank-detail-title">指标</span>
          <button type="button" class="rank-detail-close" data-collapse="1" aria-label="收起">×</button>
        </div>
        <div class="rank-detail-grid">
          <div class="mini-row"><span class="n">请求 / 次均</span><span class="v">${exact(turns)} 次/${m.avg_fmt || formatTok(turns ? m.tokens / turns : 0)}</span></div>
          <div class="mini-row"><span class="n">入/出/缓存</span><span class="v">${formatTok(m.input)} / ${formatTok(m.output)} / ${formatTok(m.cache)}</span></div>
          <div class="mini-row"><span class="n">会话</span><span class="v">${m.sessions || 0}</span></div>
          <div class="mini-row"><span class="n">命中率</span><span class="v">${m.cache_hit}%</span></div>
        </div>
        <div class="rank-detail-title">主要会话</div>
        <div class="rank-detail-list">
        ${
          sessions.length
            ? sessions
                .map(
                  (s) =>
                    `<div class="mini-row" data-session="${escapeHtml(s.id)}" style="cursor:pointer"><span class="n" title="${escapeHtml(s.title)}">${escapeHtml(s.title)}</span><span class="v">${s.fmt}</span></div>`
                )
                .join("")
            : `<div class="mini-row"><span class="n">无</span></div>`
        }
        </div>
      </div>`;
  }

  function renderProjects(projects) {
    const el = $("#project-list");
    if (!el) return;
    state.rankProjects = projects;
    if (!projects.length) {
      el.innerHTML = `<div style="color:var(--text-3);font-size:12px;padding:16px 0">暂无数据</div>`;
      return;
    }
    const sorted = sortRankItems(projects, state.projectSort);
    const limit = state.projectLimit > 0 ? state.projectLimit : sorted.length;
    el.innerHTML = sorted
      .slice(0, limit)
      .map((p) => {
        const open = state.openProject === p.name;
        return rankRow({
          name: p.name,
          meta: `${p.fmt} · ${formatShare(p.share)} · 命中 ${p.cache_hit}%`,
          pct: p.share,
          sub: `${p.sessions} 会话 · ${p.turns} 轮${p.path ? " · " + shortPath(p.path) : ""}`,
          id: p.name,
          kind: "project",
          open,
          detail: open ? renderProjectDetail(p) : "",
        });
      })
      .join("");

    bindRankEvents(el, "project", projects);
    bindDayDetailHover(el);
  }

  function renderProjectDetail(p) {
    const models = p.models || [];
    const sessions = p.top_sessions || [];
    return `
      <div class="rank-detail">
        <div class="rank-detail-head">
          <span class="rank-detail-title">模型分布</span>
          <button type="button" class="rank-detail-close" data-collapse="1" aria-label="收起">×</button>
        </div>
        <div class="rank-detail-grid">
        ${
          models.length
            ? models
                .slice(0, 8)
                .map(
                  (m) =>
                    `<div class="mini-row" data-model="${escapeHtml(m.model)}" data-tokens="${m.tokens}" data-share="${m.share}" data-turns="${m.turns || 0}" data-input="${m.input || 0}" data-output="${m.output || 0}" data-cache="${m.cache || 0}" data-cache-hit="${m.cache_hit || 0}" style="cursor:default"><span class="n">${escapeHtml(m.model)}</span><span class="v">${formatTok(m.tokens)} · ${m.share}%</span></div>`
                )
                .join("")
            : `<div class="mini-row"><span class="n">无</span></div>`
        }
        </div>
        <div class="rank-detail-title">主要会话</div>
        <div class="rank-detail-list">
        ${
          sessions.length
            ? sessions
                .map(
                  (s) =>
                    `<div class="mini-row" data-session="${escapeHtml(s.id)}" style="cursor:pointer"><span class="n" title="${escapeHtml(s.title)}">${escapeHtml(s.title)}</span><span class="v">${s.fmt} · ${s.turns} 轮</span></div>`
                )
                .join("")
            : `<div class="mini-row"><span class="n">无</span></div>`
        }
        </div>
      </div>`;
  }

  function bindRankEvents(el, kind, items) {
    el.querySelectorAll(".rank-row").forEach((row) => {
      const name = row.dataset.name;

      const toggle = () => {
        hideHoverCard();
        if (kind === "model") {
          setOpenModel(state.openModel === name ? null : name);
          renderModels(currentRankModels());
        } else {
          setOpenProject(state.openProject === name ? null : name);
          renderProjects(currentRankProjects());
        }
      };
      row.addEventListener("click", (e) => {
        if (e.target.closest("[data-collapse]")) {
          hideHoverCard();
          if (kind === "model") {
            setOpenModel(null);
            renderModels(currentRankModels());
          } else {
            setOpenProject(null);
            renderProjects(currentRankProjects());
          }
          return;
        }
        if (e.target.closest("[data-session]")) {
          openDrawer(e.target.closest("[data-session]").dataset.session);
          return;
        }
        toggle();
      });
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });
    });

    el.querySelectorAll("[data-session]").forEach((n) => {
      n.addEventListener("click", (e) => {
        e.stopPropagation();
        openDrawer(n.dataset.session);
      });
    });
  }

  // ── sessions ──────────────────────────────────────────────
  function populateModelFilter(data) {
    const sel = $("#session-model-filter");
    if (sel) {
      const models = (data.by_model || []).map((m) => m.model);
      const cur = state.modelFilter;
      sel.innerHTML =
        `<option value="">全部模型</option>` +
        models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");
      if (cur && models.includes(cur)) sel.value = cur;
      else {
        state.modelFilter = "";
        sel.value = "";
      }
    }
    const psel = $("#session-project-filter");
    if (psel) {
      const projects = (data.by_project || []).map((p) => p.name).filter(Boolean);
      const cur = state.projectFilter;
      psel.innerHTML =
        `<option value="">全部项目</option>` +
        projects.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");
      if (cur && projects.includes(cur)) psel.value = cur;
      else {
        state.projectFilter = "";
        psel.value = "";
      }
    }
    const sortSel = $("#session-sort");
    if (sortSel) sortSel.value = state.sort || "last";
  }

  function filteredSessions() {
    let list = state.sessions.slice();
    const q = state.search.trim().toLowerCase();
    if (q) {
      list = list.filter((s) =>
        [s.title, s.project_name, s.directory, s.id, (s.models || []).map((m) => m.model).join(" ")]
          .join(" ")
          .toLowerCase()
          .includes(q)
      );
    }
    if (state.modelFilter) {
      list = list.filter((s) => (s.models || []).some((m) => m.model === state.modelFilter));
    }
    if (state.projectFilter) {
      list = list.filter((s) => s.project_name === state.projectFilter);
    }
    list = sortRankItems(list, state.sort);
    return list;
  }

  function renderSessions() {
    const tbody = $("#session-tbody");
    const empty = $("#session-empty");
    const foot = $("#table-foot");
    const moreBtn = $("#btn-more");
    if (!tbody) return;
    const all = filteredSessions();
    const limit = state.sessionLimit;
    const list = limit > 0 ? all.slice(0, limit) : all;

    if (!all.length) {
      tbody.innerHTML = "";
      if (empty) empty.hidden = false;
      if (foot) foot.hidden = true;
      return;
    }
    if (empty) empty.hidden = true;

    tbody.innerHTML = list
      .map((s) => {
        const models = (s.models || []).map((m) => m.model).join(" · ");
        return `
        <tr tabindex="0" data-id="${escapeHtml(s.id)}">
          <td>
            <div class="title-cell" title="${escapeHtml(s.title)}">${escapeHtml(s.title)}</div>
            <span class="sub-line">${escapeHtml(models)}</span>
          </td>
          <td class="proj-col" title="${escapeHtml(s.directory || "")}">${escapeHtml(s.project_name || "—")}</td>
          <td class="num">${exact(s.turns)}</td>
          <td class="num">${s.cache_hit ?? 0}%</td>
          <td class="num tok-col" style="color:var(--text);font-weight:600">${s.fmt}</td>
          <td class="bar-col">
            <div class="share-cell">
              <div class="mini-bar"><i style="width:${Math.min(100, Math.max(s.share > 0 ? 2 : 0, s.share || 0))}%"></i></div>
              <span class="share-num">${s.share ?? 0}%</span>
            </div>
          </td>
          <td class="num">${escapeHtml(s.last_label || "—")}</td>
        </tr>`;
      })
      .join("");

    tbody.querySelectorAll("tr").forEach((tr) => {
      const open = () => openDrawer(tr.dataset.id);
      tr.addEventListener("click", open);
      tr.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      });
    });

    if (foot && moreBtn) {
      if (limit > 0 && all.length > limit) {
        foot.hidden = false;
        moreBtn.textContent = `显示更多（还有 ${all.length - limit} 条）`;
        moreBtn.onclick = () => {
          state.sessionLimit = 0;
          localStorage.setItem("mimo-ts-limit", "0");
          const sel = $("#session-limit");
          if (sel) sel.value = "0";
          renderSessions();
        };
      } else {
        foot.hidden = true;
      }
    }
  }

  // ── drawer ────────────────────────────────────────────────
  async function openDrawer(id) {
    if (!id) return;
    const drawer = $("#drawer");
    const backdrop = $("#drawer-backdrop");
    drawer?.classList.add("open");
    drawer?.setAttribute("aria-hidden", "false");
    if (backdrop) backdrop.hidden = false;
    document.documentElement.classList.add("scroll-locked");
    document.body.classList.add("scroll-locked");
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    const title = $("#drawer-title");
    const sub = $("#drawer-sub");
    const kpis = $("#drawer-kpis");
    const models = $("#drawer-models");
    const turns = $("#drawer-turns");
    if (title) title.textContent = "加载中…";
    if (sub) sub.textContent = "";
    if (kpis) kpis.innerHTML = "";
    if (models) models.innerHTML = "";
    if (turns) turns.innerHTML = `<div class="turn-item"><div class="t-model">加载中…</div></div>`;

    try {
      const d = await fetchJSON(`/api/session?id=${encodeURIComponent(id)}`);
      if (!d.ok) throw new Error(d.error || "加载失败");
      if (title) title.textContent = d.title || id;
      if (sub) sub.textContent = d.directory || id;
      if (kpis) {
        const t = d.totals;
        const nTurns = t.turns || 0;
        const avgFmt = formatTok(nTurns ? t.tokens / nTurns : 0);
        const cache = t.cache_read + t.cache_write;
        kpis.innerHTML = `
          <div class="dk"><div class="l">消耗</div><div class="v">${t.fmt}</div></div>
          <div class="dk"><div class="l">请求 / 次均</div><div class="v v-sm">${exact(nTurns)} 次/${avgFmt}</div></div>
          <div class="dk dk-io-desktop"><div class="l">入 / 出 / 缓存</div>
            <div class="v v-io">
              <span class="io-item"><em>入</em>${formatTok(t.input)}</span>
              <span class="io-item"><em>出</em>${formatTok(t.output)}</span>
              <span class="io-item"><em>缓存</em>${formatTok(cache)}</span>
            </div>
          </div>
          <div class="dk dk-hit-desktop"><div class="l">命中率</div><div class="v">${t.cache_hit}%</div></div>
          <div class="dk dk-io-mobile"><div class="l">入 / 出 / 缓存 · 命中率</div>
            <div class="v v-io">
              <span class="io-item"><em>入</em>${formatTok(t.input)}</span>
              <span class="io-item"><em>出</em>${formatTok(t.output)}</span>
              <span class="io-item"><em>缓存</em>${formatTok(cache)}</span>
              <span class="io-item"><em>命中</em>${t.cache_hit}%</span>
            </div>
          </div>`;
      }
      if (models) {
        const ms = d.models || [];
        models.innerHTML =
          ms
            .map((m, i) => {
              const color = MODEL_COLORS[i % MODEL_COLORS.length];
              return `
              <div class="drawer-model-row" data-model="${escapeHtml(m.model)}" data-tokens="${m.tokens}" data-share="${m.share}" data-turns="${m.turns || 0}" data-input="${m.input || 0}" data-output="${m.output || 0}" data-cache="${m.cache || 0}" data-cache-hit="${m.cache_hit || 0}">
                <div class="drawer-model-top">
                  <span class="n">${escapeHtml(m.model)}</span>
                  <span class="v">${m.fmt} · ${m.share}% · ${m.avg_fmt || "—"} · 命中 ${m.cache_hit ?? 0}%</span>
                </div>
                <div class="drawer-model-bar"><i style="width:${Math.min(100, Math.max(m.share > 0 ? 2 : 0, m.share || 0))}%;background:${color}"></i></div>
              </div>`;
            })
            .join("") || `<div style="color:var(--text-3);font-size:12px">无</div>`;
        bindDayDetailHover(models);
      }
      if (turns) {
        const all = d.turns || [];
        const hint = $("#drawer-turns-hint");
        const totalTurns = d.totals?.turns || all.length;
        if (hint) hint.textContent = all.length ? `显示最近 ${Math.min(50, all.length)} / ${exact(totalTurns)} 条` : "";
        const rows = all.slice().reverse().slice(0, 50);
        const legend = `
          <div class="turn-legend">
            <span class="leg"><i class="sw" style="background:var(--blue)"></i>入</span>
            <span class="leg"><i class="sw" style="background:var(--violet)"></i>出</span>
            <span class="leg"><i class="sw" style="background:var(--cyan)"></i>缓存</span>
          </div>`;
        turns.innerHTML =
          legend +
          (rows
            .map((t) => {
              const cache = (t.cache_read || 0) + (t.cache_write || 0);
              const sum = (t.total || 1) || 1;
              const pIn = ((t.input || 0) / sum) * 100;
              const pOut = (((t.output || 0) + (t.reasoning || 0)) / sum) * 100;
              const pCache = (cache / sum) * 100;
              const cr = t.cache_read || 0;
              const cw = t.cache_write || 0;
              const hit = cr + cw + (t.input || 0) > 0 ? Math.round((cr / (cr + cw + (t.input || 0))) * 100) : 0;
              return `
          <div class="turn-item">
            <div class="t-model">${escapeHtml(t.model)}</div>
            <div class="t-tok">${formatTok(t.total)} · 命中 ${hit}%</div>
            <div class="t-bar" title="入/出/缓存 ${formatTok(t.input)} / ${formatTok(t.output)} / ${formatTok(cache)}">
              <i style="width:${pIn}%;background:var(--blue)"></i>
              <i style="width:${pOut}%;background:var(--violet)"></i>
              <i style="width:${pCache}%;background:var(--cyan)"></i>
            </div>
            <div class="t-io">入/出/缓存 ${formatTok(t.input)} / ${formatTok(t.output)} / ${formatTok(cache)}</div>
            <div class="t-time">${escapeHtml(t.time_label)}</div>
          </div>`;
            })
            .join("") || `<div class="turn-item"><div class="t-model">无请求记录</div></div>`);
      }
    } catch (err) {
      if (turns) turns.innerHTML = `<div class="turn-item"><div class="t-model">加载失败：${escapeHtml(err.message)}</div></div>`;
    }
  }

  function closeDrawer() {
    const drawer = $("#drawer");
    const backdrop = $("#drawer-backdrop");
    drawer?.classList.remove("open");
    drawer?.setAttribute("aria-hidden", "true");
    if (backdrop) backdrop.hidden = true;
    document.documentElement.classList.remove("scroll-locked");
    document.body.classList.remove("scroll-locked");
    document.body.style.overflow = "";
    document.documentElement.style.overflow = "";
  }

  // ── insights ──────────────────────────────────────────────
  function renderInsights(data) {
    const el = $("#insight-grid");
    if (!el) return;
    const ins = data.insights || {};
    const t = data.totals || {};
    const cards = [
      {
        lbl: "峰值日",
        val: ins.peak_day ? ins.peak_day.fmt : "—",
        hint: ins.peak_day ? ins.peak_day.date : "该区间无消耗",
      },
      { lbl: "日均消耗", val: t.avg_daily_fmt || "—", hint: `${data.chart_days} 天平均` },
      {
        lbl: "最耗模型",
        val: ins.busiest_model?.model || "—",
        hint: ins.busiest_model ? `${ins.busiest_model.fmt} · ${ins.busiest_model.share}%` : "—",
      },
      {
        lbl: "最耗项目",
        val: ins.busiest_project?.name || "—",
        hint: ins.busiest_project ? `${ins.busiest_project.fmt} · ${ins.busiest_project.sessions} 会话` : "—",
      },
    ];
    el.innerHTML = cards
      .map(
        (c) => `
      <div class="insight-card">
        <div class="lbl">${escapeHtml(c.lbl)}</div>
        <div class="val" title="${escapeHtml(c.val)}">${escapeHtml(c.val)}</div>
        <div class="hint" title="${escapeHtml(c.hint)}">${escapeHtml(c.hint)}</div>
      </div>`
      )
      .join("");
  }

  // ── range / refresh ───────────────────────────────────────
  function setRange(range) {
    state.range = range;
    localStorage.setItem("mimo-ts-range", range);
    setOpenModel(null);
    setOpenProject(null);
    // 切范围时清掉日历选中，避免时段活跃在「区间汇总 / 单日」之间来回闪
    state.selectedDayDates = [];
    state.selectedHours = [];
    persistDaySelection();
    persistHourSelection();
    state.hourlyDay = null;
    state.hourlyReqId += 1;
    const dayBox = $("#day-detail");
    if (dayBox) {
      dayBox.classList.remove("open");
      dayBox.hidden = true;
    }
    const hourBox = $("#hour-detail");
    if (hourBox) {
      hourBox.classList.remove("open");
      hourBox.hidden = true;
    }
    $$(".hm-cell.selected").forEach((c) => c.classList.remove("selected"));
    $$(".hour-col.selected").forEach((c) => c.classList.remove("selected"));
    $$(".range-tab").forEach((b) => {
      const on = b.dataset.range === range;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    // 点击瞬间就进入动画态，数据到达后直接从旧高度过渡
    const chartEl = $("#hourly-chart");
    chartEl?.classList.add("animate");
    loadOverview().finally(() => {
      prefetchRanges();
    });
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    if (!state.autoRefresh) return;
    const ms = Math.max(5, Number(state.refreshSec) || 15) * 1000;
    state.timer = setInterval(() => {
      if (document.hidden) return;
      loadOverview();
    }, ms);
  }

  function stopAutoRefresh() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  function setRefreshInterval(sec) {
    const n = Number(sec);
    if (![5, 10, 15, 30, 60].includes(n)) return;
    state.refreshSec = n;
    localStorage.setItem("mimo-ts-refresh", String(n));
    if (state.autoRefresh) startAutoRefresh();
    const foot = $("#footer-meta");
    if (foot) foot.textContent = `数据来自本机 mimocode.db · 自动刷新 ${n}s`;
    const pill = $("#live-pill");
    if (pill) pill.title = state.autoRefresh ? `在线 · ${n} 秒自动刷新` : "已暂停";
  }

  function setShiftMulti(on) {
    state.shiftMulti = !!on;
    localStorage.setItem("mimo-ts-shift-multi", on ? "1" : "0");
  }

  function setFollowSystem(on) {
    state.followSystem = !!on;
    localStorage.setItem("mimo-ts-follow-system", on ? "1" : "0");
    if (on) {
      localStorage.removeItem("mimo-ts-theme");
      state.theme = systemTheme();
    } else if (!localStorage.getItem("mimo-ts-theme")) {
      localStorage.setItem("mimo-ts-theme", state.theme);
    }
    applyTheme();
  }

  function syncSettingsControls() {
    const refresh = $("#set-refresh");
    if (refresh) refresh.value = String(state.refreshSec);
    const shift = $("#set-shift-multi");
    if (shift) shift.checked = state.shiftMulti;
    const follow = $("#set-follow-system");
    if (follow) follow.checked = state.followSystem;
  }

  function toggleAutoRefresh() {
    state.autoRefresh = !state.autoRefresh;
    const pill = $("#live-pill");
    const label = $("#live-label");
    if (pill) pill.classList.toggle("paused", !state.autoRefresh);
    if (label) label.textContent = state.autoRefresh ? "在线" : "已暂停";
    if (state.autoRefresh) startAutoRefresh();
    else stopAutoRefresh();
  }

  // ── events ────────────────────────────────────────────────
  function bindEvents() {
    // Shift 多选时禁止浏览器文本选择 / 拖选
    const blockSelect = (e) => {
      if (e.shiftKey) e.preventDefault();
    };
    const heatEl = $("#heatmap-grid");
    const hourEl = $("#hourly-chart");
    heatEl?.addEventListener("mousedown", blockSelect);
    hourEl?.addEventListener("mousedown", blockSelect);
    // 点击柱子时不要抢焦点，避免 outline 闪一下像变粗
    hourEl?.addEventListener("mousedown", (e) => {
      if (e.target.closest(".hour-col")) e.preventDefault();
    });
    heatEl?.addEventListener("mousedown", (e) => {
      if (e.target.closest(".hm-cell")) e.preventDefault();
    });
    heatEl?.addEventListener("selectstart", (e) => e.preventDefault());
    hourEl?.addEventListener("selectstart", (e) => e.preventDefault());
    document.addEventListener("mouseup", () => {
      try {
        window.getSelection()?.removeAllRanges();
      } catch (_) {}
    });

    $$(".range-tab").forEach((btn) => {
      btn.addEventListener("click", () => setRange(btn.dataset.range));
    });

    $("#btn-refresh")?.addEventListener("click", async () => {
      try {
        await fetch("/api/refresh", { credentials: "same-origin" });
      } catch (_) {}
      loadOverview();
    });

    $("#btn-export")?.addEventListener("click", () => {
      window.open(`/api/export.csv?range=${encodeURIComponent(state.range)}`, "_blank");
    });

    $("#btn-theme")?.addEventListener("click", toggleTheme);

    const settingsModal = $("#settings-modal");
    const settingsBackdrop = $("#settings-backdrop");
    const openSettings = () => {
      if (!settingsModal || !settingsBackdrop) return;
      settingsModal.classList.add("open");
      settingsModal.setAttribute("aria-hidden", "false");
      settingsBackdrop.hidden = false;
      const msg = $("#password-msg");
      if (msg) {
        msg.textContent = "";
        msg.className = "settings-msg";
      }
      // 默认收起改密区
      const card = $("#password-card");
      if (card) card.hidden = true;
      syncSettingsControls();
    };
    const closeSettings = () => {
      if (!settingsModal || !settingsBackdrop) return;
      settingsModal.classList.remove("open");
      settingsModal.setAttribute("aria-hidden", "true");
      settingsBackdrop.hidden = true;
    };

    $("#btn-settings")?.addEventListener("click", openSettings);
    $("#settings-close")?.addEventListener("click", closeSettings);
    settingsBackdrop?.addEventListener("click", closeSettings);

    $("#set-refresh")?.addEventListener("change", (e) => {
      setRefreshInterval(e.target.value);
    });
    $("#set-shift-multi")?.addEventListener("change", (e) => {
      setShiftMulti(e.target.checked);
    });
    $("#set-follow-system")?.addEventListener("change", (e) => {
      setFollowSystem(e.target.checked);
    });
    syncSettingsControls();
    setRefreshInterval(state.refreshSec); // 同步页脚/标题文案

    $("#password-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const current = $("#pwd-current")?.value || "";
      const next = $("#pwd-next")?.value || "";
      const confirm = $("#pwd-confirm")?.value || "";
      const msg = $("#password-msg");
      const btn = $("#password-submit");
      const setMsg = (text, cls) => {
        if (!msg) return;
        msg.textContent = text;
        msg.className = "settings-msg" + (cls ? " " + cls : "");
      };

      if (next.length < 4) {
        setMsg("新密码至少 4 位", "err");
        return;
      }
      if (next !== confirm) {
        setMsg("两次输入的新密码不一致", "err");
        return;
      }

      if (btn) btn.disabled = true;
      setMsg("保存中…");
      try {
        const res = await fetch("/api/password", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ current, next }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) {
          setMsg(data.error || "当前密码错误", "err");
        } else if (!res.ok || !data.ok) {
          setMsg(data.error || "保存失败", "err");
        } else {
          setMsg("密码已更新", "ok");
          $("#pwd-current").value = "";
          $("#pwd-next").value = "";
          $("#pwd-confirm").value = "";
        }
      } catch (err) {
        setMsg("保存失败：" + err.message, "err");
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    $("#btn-logout")?.addEventListener("click", async () => {
      const btn = $("#btn-logout");
      if (btn) btn.disabled = true;
      try {
        await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
      } catch (_) {}
      location.href = "/login";
    });

    $("#btn-goto-password")?.addEventListener("click", () => {
      const card = $("#password-card");
      if (card) card.hidden = false;
      $("#pwd-current")?.focus();
      card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });

    $("#btn-cancel-password")?.addEventListener("click", () => {
      const card = $("#password-card");
      if (card) card.hidden = true;
      const form = $("#password-form");
      form?.reset();
      const msg = $("#password-msg");
      if (msg) {
        msg.textContent = "";
        msg.className = "settings-msg";
      }
    });

    $("#live-pill")?.addEventListener("click", toggleAutoRefresh);
    $("#drawer-close")?.addEventListener("click", closeDrawer);
    $("#drawer-backdrop")?.addEventListener("click", closeDrawer);
    // 遮罩上的滚轮/触摸不带动底层页面
    const backdrop = $("#drawer-backdrop");
    const blockScroll = (e) => {
      if ($("#drawer")?.classList.contains("open")) {
        e.preventDefault();
      }
    };
    backdrop?.addEventListener("wheel", blockScroll, { passive: false });
    backdrop?.addEventListener("touchmove", blockScroll, { passive: false });
    $("#drawer")?.addEventListener(
      "wheel",
      (e) => {
        e.stopPropagation();
      },
      { passive: true }
    );
    $("#day-detail-close")?.addEventListener("click", closeDayDetail);
    $("#hour-detail-close")?.addEventListener("click", closeHourDetail);

    $("#session-search")?.addEventListener(
      "input",
      debounce((e) => {
        state.search = e.target.value || "";
        renderSessions();
      }, 150)
    );

    $("#session-sort")?.addEventListener("change", (e) => {
      state.sort = e.target.value;
      localStorage.setItem("mimo-ts-sort", state.sort);
      renderSessions();
    });

    $("#session-model-filter")?.addEventListener("change", (e) => {
      state.modelFilter = e.target.value || "";
      renderSessions();
    });

    $("#session-project-filter")?.addEventListener("change", (e) => {
      state.projectFilter = e.target.value || "";
      renderSessions();
    });

    $("#session-limit")?.addEventListener("change", (e) => {
      state.sessionLimit = Number(e.target.value) || 0;
      localStorage.setItem("mimo-ts-limit", String(state.sessionLimit));
      renderSessions();
    });

    $("#model-limit")?.addEventListener("change", (e) => {
      state.modelLimit = Number(e.target.value) || 0;
      localStorage.setItem("mimo-ts-model-limit", String(state.modelLimit));
      renderModels(state.data?.by_model || []);
    });

    $("#model-sort")?.addEventListener("change", (e) => {
      state.modelSort = e.target.value;
      localStorage.setItem("mimo-ts-model-sort", state.modelSort);
      renderModels(state.data?.by_model || []);
    });

    $("#project-limit")?.addEventListener("change", (e) => {
      state.projectLimit = Number(e.target.value) || 0;
      localStorage.setItem("mimo-ts-project-limit", String(state.projectLimit));
      renderProjects(state.data?.by_project || []);
    });

    $("#project-sort")?.addEventListener("change", (e) => {
      state.projectSort = e.target.value;
      localStorage.setItem("mimo-ts-project-sort", state.projectSort);
      renderProjects(state.data?.by_project || []);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if ($("#settings-modal")?.classList.contains("open")) {
          closeSettings();
          return;
        }
      }
      if (e.target.matches("input, textarea, select")) return;
      if (e.key === "Escape") {
        if ($("#drawer")?.classList.contains("open")) closeDrawer();
        else if (state.openModel || state.openProject) {
          setOpenModel(null);
          setOpenProject(null);
          renderModels(currentRankModels());
          renderProjects(currentRankProjects());
        } else closeDayDetail();
      }
      if (e.key === "r" || e.key === "R") {
        fetch("/api/refresh", { credentials: "same-origin" }).then(() => loadOverview()).catch(() => loadOverview());
      }
      const map = { "1": "today", "2": "7", "3": "14", "4": "30", "5": "90", "6": "all" };
      if (map[e.key]) setRange(map[e.key]);
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) loadOverview();
    });
  }

  // ── boot ──────────────────────────────────────────────────
  function boot() {
    applyTheme();
    bindEvents();
    $$(".range-tab").forEach((b) => {
      const on = b.dataset.range === state.range;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    const limitSel = $("#session-limit");
    if (limitSel) limitSel.value = String(state.sessionLimit || 0);
    const mSel = $("#model-limit");
    if (mSel) mSel.value = String(state.modelLimit || 0);
    const mSort = $("#model-sort");
    if (mSort) mSort.value = state.modelSort || "tokens";
    const pSel = $("#project-limit");
    if (pSel) pSel.value = String(state.projectLimit || 0);
    const pSort = $("#project-sort");
    if (pSort) pSort.value = state.projectSort || "tokens";
    if (!state.autoRefresh) {
      $("#live-pill")?.classList.add("paused");
      const label = $("#live-label");
      if (label) label.textContent = "已暂停";
    }
    loadOverview().finally(() => {
      prefetchRanges();
    });
    loadHealth();
    startAutoRefresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
