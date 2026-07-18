/* Irfan & Nisa shared calendar
   Data: events kept whole in localStorage; remote JSON bin is the sync medium.
   Merge: union by id, newest updatedAt wins, deletes are tombstones. */

"use strict";

// ---------- sync backend ----------
const BIN_URL = "https://api.npoint.io/7ca1ecb241f95157a0f1";
const LS_KEY = "irfannisa.events.v1";
const THEME_KEY = "irfannisa.theme.v1";
const POLL_MS = 60000;

// ---------- state ----------
let events = loadLocal();          // {id,title,date:"YYYY-MM-DD",time:"HH:MM"|"",owner,notes,updatedAt,deleted}
let viewYear, viewMonth;           // month being shown
let sheetDate = null;              // date open in day sheet
let pushTimer = null;
let syncing = false;

const $ = (id) => document.getElementById(id);

// ---------- date helpers ----------
const pad = (n) => String(n).padStart(2, "0");
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayKey = () => keyOf(new Date());

function fmtDayLabel(dateKey) {
  const d = new Date(dateKey + "T00:00:00");
  const t = todayKey();
  const tomorrow = keyOf(new Date(Date.now() + 864e5));
  const base = d.toLocaleDateString("en-MY", { weekday: "short", day: "numeric", month: "short" });
  if (dateKey === t) return `Today · ${base}`;
  if (dateKey === tomorrow) return `Tomorrow · ${base}`;
  return base;
}

function fmtTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h % 12 || 12;
  return m ? `${h12}:${pad(m)} ${ampm}` : `${h12} ${ampm}`;
}

// ---------- storage & sync ----------
function loadLocal() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; }
  catch { return []; }
}
function saveLocal() {
  localStorage.setItem(LS_KEY, JSON.stringify(events));
}

function mergeEvents(a, b) {
  const map = new Map();
  for (const e of a) map.set(e.id, e);
  for (const e of b) {
    const cur = map.get(e.id);
    if (!cur || (e.updatedAt || 0) > (cur.updatedAt || 0)) map.set(e.id, e);
  }
  // drop tombstones older than 60 days to keep the doc small
  const cutoff = Date.now() - 60 * 864e5;
  return [...map.values()].filter((e) => !(e.deleted && e.updatedAt < cutoff));
}

function setSync(state, label) {
  $("syncDot").className = "sync-dot " + state;
  $("syncLabel").textContent = label;
}

async function syncNow(push) {
  if (syncing) return;
  syncing = true;
  setSync("busy", "syncing");
  try {
    const res = await fetch(BIN_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("fetch " + res.status);
    const doc = await res.json();
    const remote = Array.isArray(doc.events) ? doc.events : [];
    const merged = mergeEvents(remote, events);
    const changedLocally = JSON.stringify(merged) !== JSON.stringify(events);
    const remoteBehind = JSON.stringify(merged) !== JSON.stringify(remote);
    events = merged;
    if (changedLocally) { saveLocal(); renderAll(); }
    if (push || remoteBehind) {
      const put = await fetch(BIN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events, savedAt: Date.now() }),
      });
      if (!put.ok) throw new Error("put " + put.status);
    }
    setSync("ok", "synced");
  } catch (err) {
    console.warn("sync failed", err);
    setSync("err", "offline");
  } finally {
    syncing = false;
  }
}

function queuePush() {
  saveLocal();
  renderAll();
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => syncNow(true), 800);
}

// ---------- mutations ----------
function upsertEvent(data) {
  const now = Date.now();
  if (data.id) {
    const e = events.find((x) => x.id === data.id);
    if (e) Object.assign(e, data, { updatedAt: now });
  } else {
    events.push({
      id: now.toString(36) + Math.random().toString(36).slice(2, 8),
      title: data.title,
      date: data.date,
      time: data.time,
      owner: data.owner,
      notes: data.notes,
      updatedAt: now,
      deleted: false,
    });
  }
  queuePush();
}

function deleteEvent(id) {
  const e = events.find((x) => x.id === id);
  if (e) { e.deleted = true; e.updatedAt = Date.now(); }
  queuePush();
}

// ---------- rendering ----------
function liveEvents() {
  return events.filter((e) => !e.deleted);
}

function eventsOn(dateKey) {
  return liveEvents()
    .filter((e) => e.date === dateKey)
    .sort((a, b) => (a.time || "99") < (b.time || "99") ? -1 : 1);
}

const OWNER_LABEL = { irfan: "Irfan", nisa: "Nisa", both: "Us two" };

function eventCard(e) {
  const btn = document.createElement("button");
  btn.className = "up-card";
  btn.type = "button";
  const meta = [fmtTime(e.time), e.notes ? "" : null].filter(Boolean);
  btn.innerHTML = `
    <span class="spine spine-${e.owner}"></span>
    <span class="up-main">
      <span class="up-title"></span>
      <span class="up-meta">
        <span class="owner-tag tag-${e.owner}">${OWNER_LABEL[e.owner] || ""}</span>
        ${meta.length ? `<span>${meta.join(" · ")}</span>` : ""}
      </span>
      ${e.notes ? `<span class="up-notes"></span>` : ""}
    </span>`;
  btn.querySelector(".up-title").textContent = e.title;
  if (e.notes) btn.querySelector(".up-notes").textContent = e.notes;
  btn.addEventListener("click", () => openForm(e));
  return btn;
}

function renderUpcoming() {
  const list = $("upcomingList");
  list.innerHTML = "";
  const t = todayKey();
  const horizon = keyOf(new Date(Date.now() + 30 * 864e5));
  const upcoming = liveEvents()
    .filter((e) => e.date >= t && e.date <= horizon)
    .sort((a, b) => (a.date + (a.time || "99")) < (b.date + (b.time || "99")) ? -1 : 1);

  if (!upcoming.length) {
    const div = document.createElement("div");
    div.className = "empty-note";
    div.textContent = "Nothing planned for the next 30 days. Tap + to add your first activity.";
    list.appendChild(div);
    return;
  }

  let lastDate = "";
  for (const e of upcoming) {
    if (e.date !== lastDate) {
      lastDate = e.date;
      const lbl = document.createElement("div");
      lbl.className = "up-day-label" + (e.date === t ? " is-today" : "");
      lbl.textContent = fmtDayLabel(e.date);
      list.appendChild(lbl);
    }
    list.appendChild(eventCard(e));
  }
}

function renderCalendar() {
  const grid = $("calGrid");
  grid.innerHTML = "";
  const first = new Date(viewYear, viewMonth, 1);
  $("calTitle").textContent = first.toLocaleDateString("en-MY", { month: "long", year: "numeric" });

  const startOffset = (first.getDay() + 6) % 7; // Monday first
  const start = new Date(viewYear, viewMonth, 1 - startOffset);
  const t = todayKey();

  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const dk = keyOf(d);
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "cal-cell";
    if (d.getMonth() !== viewMonth) cell.classList.add("other");
    if (dk === t) cell.classList.add("today");
    cell.innerHTML = `<span class="dnum">${d.getDate()}</span><span class="cell-dots"></span>`;
    const dots = cell.querySelector(".cell-dots");
    const evs = eventsOn(dk);
    const owners = [...new Set(evs.map((e) => e.owner))].slice(0, 3);
    for (const o of owners) {
      const i2 = document.createElement("i");
      i2.className = "dot dot-" + o;
      dots.appendChild(i2);
    }
    if (evs.length > 3) {
      const more = document.createElement("i");
      more.className = "dot-more";
      more.textContent = "+";
      dots.appendChild(more);
    }
    cell.setAttribute("aria-label", d.toDateString() + (evs.length ? `, ${evs.length} activities` : ""));
    cell.addEventListener("click", () => openDay(dk));
    grid.appendChild(cell);
  }
}

function renderAll() {
  renderUpcoming();
  renderCalendar();
  if (sheetDate && !$("daySheet").hidden) fillDaySheet();
}

// ---------- day sheet ----------
function openDay(dk) {
  sheetDate = dk;
  fillDaySheet();
  show("daySheet", "dayBackdrop");
}

function fillDaySheet() {
  $("daySheetTitle").textContent = fmtDayLabel(sheetDate);
  const wrap = $("dayEvents");
  wrap.innerHTML = "";
  const evs = eventsOn(sheetDate);
  if (!evs.length) {
    const div = document.createElement("div");
    div.className = "empty-note";
    div.textContent = "Free day — nothing planned.";
    wrap.appendChild(div);
  } else {
    for (const e of evs) wrap.appendChild(eventCard(e));
  }
}

// ---------- form sheet ----------
function openForm(ev, presetDate) {
  hide("daySheet", "dayBackdrop");
  const editing = !!ev;
  $("formTitle").textContent = editing ? "Edit activity" : "New activity";
  $("fId").value = editing ? ev.id : "";
  $("fTitle").value = editing ? ev.title : "";
  $("fDate").value = editing ? ev.date : (presetDate || todayKey());
  $("fTime").value = editing ? ev.time || "" : "";
  $("fNotes").value = editing ? ev.notes || "" : "";
  $("fDelete").hidden = !editing;
  selectOwner(editing ? ev.owner : "both");
  show("formSheet", "formBackdrop");
  if (!editing) setTimeout(() => $("fTitle").focus(), 250);
}

function selectOwner(owner) {
  document.querySelectorAll(".owner-btn").forEach((b) => {
    b.classList.toggle("selected", b.dataset.owner === owner);
  });
}
function selectedOwner() {
  return document.querySelector(".owner-btn.selected")?.dataset.owner || "both";
}

// ---------- sheet plumbing ----------
function show(sheetId, backdropId) {
  $(sheetId).hidden = false;
  $(backdropId).hidden = false;
}
function hide(sheetId, backdropId) {
  $(sheetId).hidden = true;
  $(backdropId).hidden = true;
}

// ---------- theme ----------
function applyTheme(mode) {
  if (mode) document.documentElement.setAttribute("data-theme", mode);
  else document.documentElement.removeAttribute("data-theme");
  $("themeToggle").textContent = mode === "dark" ? "☾" : mode === "light" ? "☀" : "◐";
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  applyTheme(saved);
  $("themeToggle").addEventListener("click", () => {
    const current = localStorage.getItem(THEME_KEY) || "light";
    const next = current === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
}

// ---------- wire up ----------
function init() {
  initTheme();
  const now = new Date();
  viewYear = now.getFullYear();
  viewMonth = now.getMonth();

  $("prevMonth").addEventListener("click", () => {
    viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; }
    renderCalendar();
  });
  $("nextMonth").addEventListener("click", () => {
    viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; }
    renderCalendar();
  });
  $("calTitle").addEventListener("click", () => {
    viewYear = now.getFullYear(); viewMonth = now.getMonth();
    renderCalendar();
  });

  $("fabAdd").addEventListener("click", () => openForm(null));
  $("dayAddBtn").addEventListener("click", () => openForm(null, sheetDate));
  $("dayBackdrop").addEventListener("click", () => hide("daySheet", "dayBackdrop"));
  $("formBackdrop").addEventListener("click", () => hide("formSheet", "formBackdrop"));

  document.querySelectorAll(".owner-btn").forEach((b) => {
    b.addEventListener("click", () => selectOwner(b.dataset.owner));
  });

  $("eventForm").addEventListener("submit", (e) => {
    e.preventDefault();
    upsertEvent({
      id: $("fId").value || null,
      title: $("fTitle").value.trim(),
      date: $("fDate").value,
      time: $("fTime").value,
      owner: selectedOwner(),
      notes: $("fNotes").value.trim(),
    });
    hide("formSheet", "formBackdrop");
  });

  $("fDelete").addEventListener("click", () => {
    if (confirm("Delete this activity?")) {
      deleteEvent($("fId").value);
      hide("formSheet", "formBackdrop");
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) syncNow(false);
  });
  setInterval(() => { if (!document.hidden) syncNow(false); }, POLL_MS);

  renderAll();
  syncNow(false);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
