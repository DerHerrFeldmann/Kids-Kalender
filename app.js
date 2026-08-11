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
  // For "both" days: which brush ("mine" or "ex") was already on the day
  // before the tap that combined it, so that color stays on the left/first
  // side of the diagonal split.
  splitOrder: {},
  settings: {
    mineName: "Ich",
    exName: "Ex",
    mineColor: "#a3cf8f",
    exColor: "#f7dd86",
  },
  activeBrush: "mine",
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
  const firstBrush = recorded === "mine" || recorded === "ex" ? recorded : "ex";
  const secondBrush = firstBrush === "mine" ? "ex" : "mine";
  const colorOf = (brush) => (brush === "mine" ? state.settings.mineColor : state.settings.exColor);
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
  "none:mine": "mine",
  "none:ex": "ex",
  "mine:mine": "none",
  "ex:ex": "none",
  "mine:ex": "both",
  "ex:mine": "both",
  "both:mine": "ex",
  "both:ex": "mine",
};

function nextOwner(current, brush) {
  return COMBINE_TABLE[`${current}:${brush}`];
}

/** Counts nights per parent in a month; a "both" day counts as half a night each. */
function monthStats(displayedMonth) {
  const year = displayedMonth.getFullYear();
  const month = displayedMonth.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  let mine = 0;
  let ex = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    const owner = ownerAt(new Date(year, month, day));
    if (owner === "mine") mine += 1;
    else if (owner === "ex") ex += 1;
    else if (owner === "both") {
      mine += 0.5;
      ex += 0.5;
    }
  }
  return { mine, ex };
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

function loadState() {
  for (const [stateKey, storageKey] of Object.entries(JSON_FIELDS)) {
    state[stateKey] = loadJSON(storageKey, {});
  }
  try {
    const savedSettings = JSON.parse(localStorage.getItem("kk.settings"));
    if (savedSettings) {
      state.settings = { ...state.settings, ...savedSettings };
    }
  } catch {
    // ignore malformed settings, defaults stay in place
  }
  const savedBrush = localStorage.getItem("kk.activeBrush");
  if (savedBrush === "mine" || savedBrush === "ex") {
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
  if (updated === "both" && (current === "mine" || current === "ex")) {
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
    [document.getElementById("mineBrush"), "mine", state.settings.mineColor],
    [document.getElementById("exBrush"), "ex", state.settings.exColor],
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

function render() {
  document.documentElement.style.setProperty("--mine-color", state.settings.mineColor);
  document.documentElement.style.setProperty("--ex-color", state.settings.exColor);

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
  document.getElementById("mineStatDot").style.background = state.settings.mineColor;
  document.getElementById("exStatDot").style.background = state.settings.exColor;
  document.getElementById("mineStatLabel").textContent = `${state.settings.mineName}: ${formatNights(stats.mine)}`;
  document.getElementById("exStatLabel").textContent = `${state.settings.exName}: ${formatNights(stats.ex)}`;

  document.getElementById("mineLabel").textContent = state.settings.mineName;
  document.getElementById("exLabel").textContent = state.settings.exName;
  document.getElementById("mineDot").style.background = state.settings.mineColor;
  document.getElementById("exDot").style.background = state.settings.exColor;
  updateBrushActiveStyles();
}

function drawCellBackground(ctx, rect, cell) {
  const { x, y, w, h } = rect;
  if (cell.owner === "none") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x, y, w, h);
    return;
  }
  if (cell.owner === "mine") {
    ctx.fillStyle = state.settings.mineColor;
    ctx.fillRect(x, y, w, h);
    return;
  }
  if (cell.owner === "ex") {
    ctx.fillStyle = state.settings.exColor;
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
  { settingsKey: "mineName", inputId: "mineNameInput", fallback: "Ich" },
  { settingsKey: "mineColor", inputId: "mineColorInput" },
  { settingsKey: "exName", inputId: "exNameInput", fallback: "Ex" },
  { settingsKey: "exColor", inputId: "exColorInput" },
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

function closeSettings() {
  for (const { settingsKey, inputId, fallback } of SETTINGS_FIELDS) {
    const value = document.getElementById(inputId).value;
    state.settings[settingsKey] = fallback ? value.trim() || fallback : value;
  }
  saveSettings();
  render();
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
    version: 1,
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
    state.entries = data.entries || {};
    state.notes = data.notes || {};
    state.splitOrder = data.splitOrder || {};
    state.settings = { ...state.settings, ...(data.settings || {}) };
    saveJSON("entries");
    saveJSON("notes");
    saveJSON("splitOrder");
    saveSettings();
    populateSettingsForm();
    render();
  };
  reader.readAsText(file);
}

function init() {
  loadState();
  render();

  document.getElementById("prevMonth").addEventListener("click", () => {
    state.displayedMonth = addMonths(state.displayedMonth, -1);
    render();
  });
  document.getElementById("nextMonth").addEventListener("click", () => {
    state.displayedMonth = addMonths(state.displayedMonth, 1);
    render();
  });

  document.getElementById("mineBrush").addEventListener("click", () => {
    state.activeBrush = "mine";
    saveBrush();
    updateBrushActiveStyles();
  });
  document.getElementById("exBrush").addEventListener("click", () => {
    state.activeBrush = "ex";
    saveBrush();
    updateBrushActiveStyles();
  });

  document.getElementById("settingsBtn").addEventListener("click", openSettings);
  document.getElementById("settingsDialog").addEventListener("close", closeSettings);
  document.getElementById("shareBtn").addEventListener("click", shareCalendar);

  document.getElementById("noteDialog").addEventListener("close", closeNoteDialog);
  document.getElementById("exportBtn").addEventListener("click", exportBackup);
  document.getElementById("restoreBtn").addEventListener("click", triggerRestore);
  document.getElementById("restoreInput").addEventListener("change", handleRestoreFile);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
