const WEEKDAY_SYMBOLS = ["MO", "DI", "MI", "DO", "FR", "SA", "SO"];

// Mirrors --outside-opacity from styles.css, which the DOM grid applies
// directly via CSS. The canvas export can't use CSS, so it reads the same
// value here rather than hardcoding a second copy of the number.
const OUTSIDE_MONTH_OPACITY =
  parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--outside-opacity")) || 0.45;

const state = {
  displayedMonth: startOfMonth(new Date()),
  entries: {},
  notes: {},
  // For "both" days: which brush ("p1" or "p2") was already on the day
  // before the tap that combined it, so that color stays on the left/first
  // side of the diagonal split.
  splitOrder: {},
  settings: {
    p1Name: "Papa",
    p2Name: "Mama",
    p1Color: "#a3cf8f",
    p2Color: "#f7dd86",
  },
  activeBrush: "p1",
};

// Set while a long-press note-dialog is open, so the click event that
// follows the release on touch devices doesn't also cycle the brush color.
let noteEditingDate = null;
let longPressTimer = null;
let longPressFired = false;

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date, count) {
  return new Date(date.getFullYear(), date.getMonth() + count, 1);
}

function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function mondayIndex(date) {
  return (date.getDay() + 6) % 7; // Monday = 0 ... Sunday = 6
}

function addDays(date, count) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + count);
}

function ownerAt(date) {
  return state.entries[dateKey(date)] || "none";
}

/**
 * For a "both" day, decides which color starts the diagonal split (the base
 * fill) and which finishes it (the overlay triangle). This follows tap
 * order: whichever brush was on the day first (before the tap that combined
 * it into "both") stays on the left/first side; see `state.splitOrder`,
 * which `applyBrush` records at the moment of combining.
 */
function splitColorsFor(date) {
  const recorded = state.splitOrder[dateKey(date)];
  const firstBrush = recorded === "p1" || recorded === "p2" ? recorded : "p2";
  const secondBrush = firstBrush === "p1" ? "p2" : "p1";
  const colorOf = (brush) => (brush === "p1" ? state.settings.p1Color : state.settings.p2Color);
  return { first: colorOf(firstBrush), second: colorOf(secondBrush) };
}

/** Everything both the DOM grid and the canvas export need to know about one day. */
function describeCell(date) {
  const key = dateKey(date);
  const owner = ownerAt(date);
  return {
    key,
    owner,
    hasNote: Boolean(state.notes[key]),
    split: owner === "both" ? splitColorsFor(date) : null,
  };
}

/**
 * Returns one entry per grid cell, including the tail end of the previous
 * month and the start of the next one so the 7-column grid is always full.
 * `current` marks whether the date actually belongs to `displayedMonth`.
 */
function buildMonthCells(displayedMonth) {
  const year = displayedMonth.getFullYear();
  const month = displayedMonth.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leading = mondayIndex(firstOfMonth);

  const cells = [];
  for (let i = leading; i > 0; i--) {
    cells.push({ date: addDays(firstOfMonth, -i), current: false });
  }
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push({ date: new Date(year, month, day), current: true });
  }
  const lastOfMonth = new Date(year, month, daysInMonth);
  for (let i = 1; cells.length % 7 !== 0; i++) {
    cells.push({ date: addDays(lastOfMonth, i), current: false });
  }
  return cells;
}

function monthTitle(date) {
  const monthName = date.toLocaleString("de-DE", { month: "long" }).toUpperCase();
  const yy = String(date.getFullYear()).slice(-2);
  return `${monthName} ${yy}`;
}

const COMBINE_TABLE = {
  "none:p1": "p1",
  "none:p2": "p2",
  "p1:p1": "none",
  "p2:p2": "none",
  "p1:p2": "both",
  "p2:p1": "both",
  "both:p1": "p2",
  "both:p2": "p1",
};

function nextOwner(current, brush) {
  return COMBINE_TABLE[`${current}:${brush}`];
}

/** Counts nights per parent in a month; a "both" day counts as half a night each. */
function monthStats(displayedMonth) {
  const year = displayedMonth.getFullYear();
  const month = displayedMonth.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  let p1 = 0;
  let p2 = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    const owner = ownerAt(new Date(year, month, day));
    if (owner === "p1") p1 += 1;
    else if (owner === "p2") p2 += 1;
    else if (owner === "both") {
      p1 += 0.5;
      p2 += 0.5;
    }
  }
  return { p1, p2 };
}

function formatNights(n) {
  return n.toLocaleString("de-DE", { maximumFractionDigits: 1 });
}

// Plain JSON-object fields, each independently loaded/saved under its own
// localStorage key so a corrupt value in one can't wipe the others.
const JSON_FIELDS = {
  entries: "kk.entries",
  notes: "kk.notes",
  splitOrder: "kk.splitOrder",
};

function loadJSON(storageKey, fallback) {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(stateKey) {
  localStorage.setItem(JSON_FIELDS[stateKey], JSON.stringify(state[stateKey]));
}

// One-time migration from the original "mine"/"ex" naming to the neutral
// "p1"/"p2" scheme, so a calendar already filled in before this rename
// keeps working instead of losing its data.
function migrateLegacyOwner(value) {
  if (value === "mine") return "p1";
  if (value === "ex") return "p2";
  return value;
}

function migrateLegacyOwnerMap(map) {
  const migrated = {};
  for (const [key, value] of Object.entries(map)) {
    migrated[key] = migrateLegacyOwner(value);
  }
  return migrated;
}

const LEGACY_SETTINGS_KEYS = {
  mineName: "p1Name",
  exName: "p2Name",
  mineColor: "p1Color",
  exColor: "p2Color",
};

function loadState() {
  for (const [stateKey, storageKey] of Object.entries(JSON_FIELDS)) {
    const loaded = loadJSON(storageKey, {});
    state[stateKey] = stateKey === "settings" ? loaded : migrateLegacyOwnerMap(loaded);
  }
  try {
    const savedSettings = JSON.parse(localStorage.getItem("kk.settings"));
    if (savedSettings) {
      state.settings = { ...state.settings, ...savedSettings };
      for (const [legacyKey, newKey] of Object.entries(LEGACY_SETTINGS_KEYS)) {
        if (savedSettings[legacyKey] !== undefined) {
          state.settings[newKey] = savedSettings[legacyKey];
        }
      }
    }
  } catch {
    // ignore malformed settings, defaults stay in place
  }
  const savedBrush = migrateLegacyOwner(localStorage.getItem("kk.activeBrush"));
  if (savedBrush === "p1" || savedBrush === "p2") {
    state.activeBrush = savedBrush;
  }
}

function saveSettings() {
  localStorage.setItem("kk.settings", JSON.stringify(state.settings));
}

function saveBrush() {
  localStorage.setItem("kk.activeBrush", state.activeBrush);
}

function applyBrush(date) {
  const key = dateKey(date);
  const current = state.entries[key] || "none";
  const updated = nextOwner(current, state.activeBrush);
  if (updated === "none") {
    delete state.entries[key];
  } else {
    state.entries[key] = updated;
  }
  if (updated === "both" && (current === "p1" || current === "p2")) {
    // records the tap order for splitColorsFor()
    state.splitOrder[key] = current;
  } else if (updated !== "both") {
    delete state.splitOrder[key];
  }
  saveJSON("entries");
  saveJSON("splitOrder");
  render();
}

function updateBrushActiveStyles() {
  const buttons = [
    [document.getElementById("p1Brush"), "p1", state.settings.p1Color],
    [document.getElementById("p2Brush"), "p2", state.settings.p2Color],
  ];
  for (const [btn, brush, color] of buttons) {
    if (state.activeBrush === brush) {
      btn.style.borderColor = color;
      btn.style.background = `${color}33`;
    } else {
      btn.style.borderColor = "transparent";
      btn.style.background = "";
    }
  }
}

/** Builds a single day cell, styled but without the interactive listeners (added separately for the live grid). */
function buildDayCell(date, current) {
  const cell = document.createElement("button");
  cell.className = "day-cell";
  if (!current) {
    cell.classList.add("outside");
  }
  const { owner, hasNote, split } = describeCell(date);
  if (owner !== "none") {
    cell.classList.add(owner);
  }
  if (split) {
    cell.style.setProperty("--cell-first", split.first);
    cell.style.setProperty("--cell-second", split.second);
  }
  const num = document.createElement("span");
  num.className = "num";
  num.textContent = String(date.getDate());
  cell.appendChild(num);
  if (hasNote) {
    const dot = document.createElement("span");
    dot.className = "note-dot";
    cell.appendChild(dot);
  }
  return cell;
}

/** Builds a static, non-interactive calendar card for `month` — used as the sliding preview during a swipe. */
function buildCardContent(month) {
  const card = document.createElement("div");
  card.className = "calendar-card";

  const title = document.createElement("h1");
  title.className = "month-title";
  title.textContent = monthTitle(month);
  card.appendChild(title);

  const weekdayRow = document.createElement("div");
  weekdayRow.className = "weekday-row";
  for (const symbol of WEEKDAY_SYMBOLS) {
    const span = document.createElement("span");
    span.textContent = symbol;
    weekdayRow.appendChild(span);
  }
  card.appendChild(weekdayRow);

  const grid = document.createElement("div");
  grid.className = "day-grid";
  for (const { date, current } of buildMonthCells(month)) {
    grid.appendChild(buildDayCell(date, current));
  }
  card.appendChild(grid);

  return card;
}

function render() {
  document.documentElement.style.setProperty("--p1-color", state.settings.p1Color);
  document.documentElement.style.setProperty("--p2-color", state.settings.p2Color);

  document.getElementById("monthTitle").textContent = monthTitle(state.displayedMonth);

  const weekdayRow = document.getElementById("weekdayRow");
  weekdayRow.innerHTML = "";
  for (const symbol of WEEKDAY_SYMBOLS) {
    const span = document.createElement("span");
    span.textContent = symbol;
    weekdayRow.appendChild(span);
  }

  // A render() can land mid-long-press (e.g. switching months while a
  // press is pending); the grid below gets rebuilt either way, so any
  // scheduled note-dialog-open for the old cell must be cancelled with it.
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }

  const grid = document.getElementById("dayGrid");
  grid.innerHTML = "";
  for (const { date, current } of buildMonthCells(state.displayedMonth)) {
    const cell = buildDayCell(date, current);

    cell.addEventListener("pointerdown", () => {
      longPressFired = false;
      longPressTimer = setTimeout(() => {
        longPressFired = true;
        openNoteDialog(date);
      }, 500);
    });
    const cancelLongPress = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };
    cell.addEventListener("pointerup", cancelLongPress);
    cell.addEventListener("pointerleave", cancelLongPress);
    cell.addEventListener("pointercancel", cancelLongPress);
    cell.addEventListener("click", () => {
      if (longPressFired) {
        longPressFired = false;
        return;
      }
      applyBrush(date);
    });

    grid.appendChild(cell);
  }

  const stats = monthStats(state.displayedMonth);
  document.getElementById("p1StatDot").style.background = state.settings.p1Color;
  document.getElementById("p2StatDot").style.background = state.settings.p2Color;
  document.getElementById("p1StatLabel").textContent = `${state.settings.p1Name}: ${formatNights(stats.p1)}`;
  document.getElementById("p2StatLabel").textContent = `${state.settings.p2Name}: ${formatNights(stats.p2)}`;

  document.getElementById("p1Label").textContent = state.settings.p1Name;
  document.getElementById("p2Label").textContent = state.settings.p2Name;
  document.getElementById("p1Dot").style.background = state.settings.p1Color;
  document.getElementById("p2Dot").style.background = state.settings.p2Color;
  updateBrushActiveStyles();
}

function drawCellBackground(ctx, rect, cell) {
  const { x, y, w, h } = rect;
  if (cell.owner === "none") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x, y, w, h);
    return;
  }
  if (cell.owner === "p1") {
    ctx.fillStyle = state.settings.p1Color;
    ctx.fillRect(x, y, w, h);
    return;
  }
  if (cell.owner === "p2") {
    ctx.fillStyle = state.settings.p2Color;
    ctx.fillRect(x, y, w, h);
    return;
  }
  // both: see splitColorsFor() for how first/second are decided
  ctx.fillStyle = cell.split.first;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = cell.split.second;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
  ctx.fill();
}

function drawCalendarToCanvas(canvas) {
  const cells = buildMonthCells(state.displayedMonth);
  const cols = 7;
  const rows = cells.length / 7;
  const cellW = 108;
  const cellH = 132;
  const headerH = 110;
  const weekdayH = 56;
  const width = cellW * cols;
  const height = headerH + weekdayH + cellH * rows;

  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "#1c1c1e";
  ctx.font = "800 46px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(monthTitle(state.displayedMonth), width / 2, headerH / 2);

  ctx.fillStyle = "#3a3a3f";
  ctx.fillRect(0, headerH, width, weekdayH);
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 20px -apple-system, BlinkMacSystemFont, sans-serif";
  WEEKDAY_SYMBOLS.forEach((symbol, i) => {
    ctx.fillText(symbol, i * cellW + cellW / 2, headerH + weekdayH / 2);
  });

  cells.forEach(({ date, current }, index) => {
    const col = index % 7;
    const row = Math.floor(index / 7);
    const x = col * cellW;
    const y = headerH + weekdayH + row * cellH;

    ctx.globalAlpha = current ? 1 : OUTSIDE_MONTH_OPACITY;
    const cellInfo = describeCell(date);
    drawCellBackground(ctx, { x, y, w: cellW, h: cellH }, cellInfo);
    ctx.fillStyle = "#1c1c1e";
    ctx.font = "600 24px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(String(date.getDate()), x + 10, y + 8);
    if (cellInfo.hasNote) {
      ctx.beginPath();
      ctx.fillStyle = "#1c1c1e";
      ctx.arc(x + cellW - 14, y + cellH - 14, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    ctx.strokeStyle = "rgba(0,0,0,0.12)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, cellW, cellH);
  });
}

async function shareCalendar() {
  const canvas = document.getElementById("shareCanvas");
  drawCalendarToCanvas(canvas);

  canvas.toBlob(async (blob) => {
    if (!blob) return;
    const file = new File([blob], `kalender-${dateKey(state.displayedMonth)}.png`, {
      type: "image/png",
    });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: monthTitle(state.displayedMonth) });
      } catch {
        // user cancelled the share sheet, nothing to do
      }
    } else {
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
    }
  }, "image/png");
}

// `fallback` marks name fields, which get trimmed and defaulted; color
// inputs always yield a valid hex value, so they're taken as-is.
const SETTINGS_FIELDS = [
  { settingsKey: "p1Name", inputId: "p1NameInput", fallback: "Papa" },
  { settingsKey: "p1Color", inputId: "p1ColorInput" },
  { settingsKey: "p2Name", inputId: "p2NameInput", fallback: "Mama" },
  { settingsKey: "p2Color", inputId: "p2ColorInput" },
];

function populateSettingsForm() {
  for (const { settingsKey, inputId } of SETTINGS_FIELDS) {
    document.getElementById(inputId).value = state.settings[settingsKey];
  }
}

function openSettings() {
  populateSettingsForm();
  document.getElementById("settingsDialog").showModal();
}

// Saved on every keystroke/color pick, not just on dialog close: closing a
// <dialog> relies on a "close" event that a background app-kill (e.g. iOS
// suspending the PWA before the user's tap on "Fertig" is fully processed)
// can skip entirely, which used to silently drop the change.
function commitSettingField(settingsKey, inputId, fallback) {
  const value = document.getElementById(inputId).value;
  state.settings[settingsKey] = fallback ? value.trim() || fallback : value;
  saveSettings();
  render();
}

function wireSettingsInputs() {
  for (const { settingsKey, inputId, fallback } of SETTINGS_FIELDS) {
    document
      .getElementById(inputId)
      .addEventListener("input", () => commitSettingField(settingsKey, inputId, fallback));
  }
}

function closeSettings() {
  for (const { settingsKey, inputId, fallback } of SETTINGS_FIELDS) {
    commitSettingField(settingsKey, inputId, fallback);
  }
}

function formatFullDate(date) {
  return date.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function openNoteDialog(date) {
  noteEditingDate = date;
  const dialog = document.getElementById("noteDialog");
  // Escape-to-cancel leaves returnValue untouched, so it must be cleared
  // here — otherwise a stale "save" from a previous visit would replay.
  dialog.returnValue = "";
  document.getElementById("noteDialogTitle").textContent = formatFullDate(date);
  document.getElementById("noteInput").value = state.notes[dateKey(date)] || "";
  dialog.showModal();
}

function closeNoteDialog() {
  const dialog = document.getElementById("noteDialog");
  const key = dateKey(noteEditingDate);
  if (dialog.returnValue === "delete") {
    delete state.notes[key];
  } else if (dialog.returnValue === "save") {
    const text = document.getElementById("noteInput").value.trim();
    if (text) {
      state.notes[key] = text;
    } else {
      delete state.notes[key];
    }
  }
  saveJSON("notes");
  render();
}

async function exportBackup() {
  const payload = {
    version: 2,
    entries: state.entries,
    notes: state.notes,
    splitOrder: state.splitOrder,
    settings: state.settings,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const file = new File([blob], "kinder-kalender-backup.json", { type: "application/json" });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Kinder Kalender Backup" });
      return;
    } catch {
      // user cancelled the share sheet, fall through to the download link
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "kinder-kalender-backup.json";
  link.click();
  URL.revokeObjectURL(url);
}

function triggerRestore() {
  document.getElementById("restoreInput").click();
}

function handleRestoreFile(event) {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try {
      data = JSON.parse(reader.result);
    } catch {
      window.alert("Diese Datei sieht nicht wie eine gültige Sicherung aus.");
      return;
    }
    if (!data || typeof data.entries !== "object") {
      window.alert("Diese Datei sieht nicht wie eine gültige Sicherung aus.");
      return;
    }
    if (!window.confirm("Aktuelle Kalendereinträge und Einstellungen durch die Sicherung ersetzen?")) {
      return;
    }
    state.entries = migrateLegacyOwnerMap(data.entries || {});
    state.notes = data.notes || {};
    state.splitOrder = migrateLegacyOwnerMap(data.splitOrder || {});
    state.settings = { ...state.settings, ...(data.settings || {}) };
    for (const [legacyKey, newKey] of Object.entries(LEGACY_SETTINGS_KEYS)) {
      if (data.settings && data.settings[legacyKey] !== undefined) {
        state.settings[newKey] = data.settings[legacyKey];
      }
    }
    saveJSON("entries");
    saveJSON("notes");
    saveJSON("splitOrder");
    saveSettings();
    populateSettingsForm();
    render();
  };
  reader.readAsText(file);
}

function changeMonth(delta) {
  state.displayedMonth = addMonths(state.displayedMonth, delta);
  render();
}

const SWIPE_THRESHOLD = 60;
const SLIDE_DURATION = 220; // ms for a button-triggered slide, or a drag's remaining distance

function isViewportSliding() {
  return document.getElementById("calendarViewport").classList.contains("sliding");
}

/** Positions the live card and its preview neighbor for a given horizontal drag offset `dx`. */
function positionSlide(card, peekCard, peekDelta, dx, width) {
  const peekRestDx = peekDelta > 0 ? width : -width;
  card.style.transform = `translateX(${dx}px)`;
  peekCard.style.transform = `translateX(${peekRestDx + dx}px)`;
}

/**
 * Slides the calendar card the rest of the way off-screen to reveal `delta`
 * months away, like a page being pushed out while the next one is pushed in
 * from the other edge. `fromDx`/`peekCard` let a drag in progress (which
 * already built its own preview and moved partway) hand off into the same
 * motion instead of jumping; omit them for a plain button tap.
 */
function slideToMonth(delta, fromDx = 0, existingPeekCard = null) {
  const viewport = document.getElementById("calendarViewport");
  const card = document.getElementById("calendarCard");
  const width = viewport.getBoundingClientRect().width;
  const targetDx = delta > 0 ? -width : width;

  viewport.classList.add("sliding");
  const peekCard = existingPeekCard || buildCardContent(addMonths(state.displayedMonth, delta));
  peekCard.classList.add("calendar-card--peek");
  if (!existingPeekCard) viewport.appendChild(peekCard);

  // Months have 5 or 6 week rows, so the card's own natural height can
  // differ from the incoming one — read both so the viewport's height (and
  // therefore everything below it, like the stats row) can be animated
  // right along with the slide instead of jumping once it lands.
  const cardHeight = card.getBoundingClientRect().height;
  const peekHeight = peekCard.getBoundingClientRect().height;

  const finish = () => {
    changeMonth(delta);
    peekCard.remove();
    card.style.transition = "none";
    card.style.transform = "translateX(0px)";
    viewport.style.transition = "none";
    viewport.style.height = "";
    void card.offsetHeight; // force reflow so the reset above isn't transitioned
    card.style.transition = "";
    viewport.style.transition = "";
    viewport.classList.remove("sliding");
  };

  card.style.transition = "none";
  peekCard.style.transition = "none";
  viewport.style.transition = "none";
  positionSlide(card, peekCard, delta, fromDx, width);
  viewport.style.height = `${cardHeight + (peekHeight - cardHeight) * (Math.abs(fromDx) / width)}px`;
  void card.offsetHeight;

  if (Math.abs(fromDx - targetDx) < 1) {
    finish(); // already fully there (e.g. a drag that reached the edge) — nothing left to animate
    return;
  }

  card.style.transition = `transform ${SLIDE_DURATION}ms ease-out`;
  peekCard.style.transition = `transform ${SLIDE_DURATION}ms ease-out`;
  viewport.style.transition = `height ${SLIDE_DURATION}ms ease-out`;
  requestAnimationFrame(() => {
    card.style.transform = `translateX(${targetDx}px)`;
    peekCard.style.transform = "translateX(0px)";
    viewport.style.height = `${peekHeight}px`;
  });

  card.addEventListener("transitionend", function onEnd() {
    card.removeEventListener("transitionend", onEnd);
    finish();
  });
}

/** Slides the card and its preview back flat without changing the month — a drag that didn't clear the threshold. */
function cancelSlide(fromDx, peekCard, peekDelta, width) {
  const viewport = document.getElementById("calendarViewport");
  const card = document.getElementById("calendarCard");

  const finish = () => {
    peekCard.remove();
    card.style.transition = "none";
    card.style.transform = "translateX(0px)";
    viewport.style.transition = "none";
    viewport.style.height = "";
    void card.offsetHeight; // force reflow so the reset above isn't transitioned
    card.style.transition = "";
    viewport.style.transition = "";
    viewport.classList.remove("sliding");
  };

  if (Math.abs(fromDx) < 1) {
    finish();
    return;
  }

  const cardHeight = card.getBoundingClientRect().height;

  card.style.transition = `transform ${SLIDE_DURATION}ms ease-out`;
  peekCard.style.transition = `transform ${SLIDE_DURATION}ms ease-out`;
  viewport.style.transition = `height ${SLIDE_DURATION}ms ease-out`;
  requestAnimationFrame(() => {
    positionSlide(card, peekCard, peekDelta, 0, width);
    viewport.style.height = `${cardHeight}px`;
  });

  card.addEventListener("transitionend", function onEnd() {
    card.removeEventListener("transitionend", onEnd);
    finish();
  });
}

/**
 * A horizontal drag on the calendar switches months, like a native paging
 * gesture: the next or previous month's card slides in from the edge in
 * real time as it's dragged — it follows the finger 1:1 rather than waiting
 * for release — and either finishes sliding into place or springs back flat
 * once you let go. It also has to interrupt whatever the day-cell underneath
 * was about to do (tap-to-color or a pending long-press note), since a real
 * swipe usually starts on top of a cell.
 */
function initSwipeNavigation() {
  const viewport = document.getElementById("calendarViewport");
  const card = document.getElementById("calendarCard");
  let startX = null;
  let startY = null;
  let isSwiping = false;
  let width = 0;
  let peekCard = null;
  let peekDelta = 0;
  let lastDx = 0;

  const ensurePeek = (delta) => {
    if (peekCard && peekDelta === delta) return;
    if (peekCard) peekCard.remove();
    peekDelta = delta;
    peekCard = buildCardContent(addMonths(state.displayedMonth, delta));
    peekCard.classList.add("calendar-card--peek");
    peekCard.style.transition = "none";
    viewport.appendChild(peekCard);
  };

  viewport.addEventListener("pointerdown", (event) => {
    if (isViewportSliding()) return;
    startX = event.clientX;
    startY = event.clientY;
    isSwiping = false;
  });

  viewport.addEventListener("pointermove", (event) => {
    if (startX === null) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!isSwiping) {
      if (Math.abs(dx) <= 10 || Math.abs(dx) <= Math.abs(dy) * 1.5) return;
      isSwiping = true;
      viewport.setPointerCapture(event.pointerId); // keep receiving move/up even once the finger strays outside the card
      viewport.classList.add("sliding");
      width = viewport.getBoundingClientRect().width;
      viewport.style.height = `${card.getBoundingClientRect().height}px`; // pin explicit height so it can be animated instead of jumping
      card.style.transition = "none";
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      longPressFired = true; // swallow the click a real drag would otherwise leave behind
    }
    const clampedDx = Math.max(-width, Math.min(width, dx));
    lastDx = clampedDx;
    ensurePeek(clampedDx < 0 ? 1 : -1);
    // Months have 5 or 6 week rows, so the incoming card's natural height
    // can differ from the current one — blend the viewport towards it as
    // the drag progresses instead of snapping once it lands.
    const cardHeight = card.getBoundingClientRect().height;
    const peekHeight = peekCard.getBoundingClientRect().height;
    const progress = Math.abs(clampedDx) / width;
    viewport.style.height = `${cardHeight + (peekHeight - cardHeight) * progress}px`;
    positionSlide(card, peekCard, peekDelta, clampedDx, width);
  });

  viewport.addEventListener("pointerup", (event) => {
    if (isSwiping) {
      const dx = Math.max(-width, Math.min(width, event.clientX - startX));
      if (dx <= -SWIPE_THRESHOLD) slideToMonth(1, dx, peekDelta === 1 ? peekCard : null);
      else if (dx >= SWIPE_THRESHOLD) slideToMonth(-1, dx, peekDelta === -1 ? peekCard : null);
      else cancelSlide(dx, peekCard, peekDelta, width);
    }
    startX = null;
    startY = null;
    isSwiping = false;
    peekCard = null;
    peekDelta = 0;
    lastDx = 0;
  });

  viewport.addEventListener("pointercancel", () => {
    if (isSwiping) cancelSlide(lastDx, peekCard, peekDelta, width);
    startX = null;
    startY = null;
    isSwiping = false;
    peekCard = null;
    peekDelta = 0;
    lastDx = 0;
  });
}

function init() {
  loadState();
  render();
  initSwipeNavigation();

  document.getElementById("prevMonth").addEventListener("click", () => {
    if (!isViewportSliding()) slideToMonth(-1);
  });
  document.getElementById("nextMonth").addEventListener("click", () => {
    if (!isViewportSliding()) slideToMonth(1);
  });

  document.getElementById("p1Brush").addEventListener("click", () => {
    state.activeBrush = "p1";
    saveBrush();
    updateBrushActiveStyles();
  });
  document.getElementById("p2Brush").addEventListener("click", () => {
    state.activeBrush = "p2";
    saveBrush();
    updateBrushActiveStyles();
  });

  document.getElementById("settingsBtn").addEventListener("click", openSettings);
  wireSettingsInputs();
  document.getElementById("settingsDialog").addEventListener("close", closeSettings);
  document.getElementById("shareBtn").addEventListener("click", shareCalendar);

  document.getElementById("noteDialog").addEventListener("close", closeNoteDialog);
  document.getElementById("exportBtn").addEventListener("click", exportBackup);
  document.getElementById("restoreBtn").addEventListener("click", triggerRestore);
  document.getElementById("restoreInput").addEventListener("change", handleRestoreFile);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
    // Once a newly-installed service worker takes over, the page it took
    // over on is still running the old cached app.js — reload once so the
    // new version actually shows up instead of waiting for the next launch.
    let reloadedForNewVersion = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloadedForNewVersion) return;
      reloadedForNewVersion = true;
      window.location.reload();
    });
  }
}

init();
