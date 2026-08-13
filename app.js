const WEEKDAY_SYMBOLS = ["MO", "DI", "MI", "DO", "FR", "SA", "SO"];

// Mirrors --outside-opacity from styles.css, which the DOM grid applies
// directly via CSS. The canvas export can't use CSS, so it reads the same
// value here rather than hardcoding a second copy of the number.
const OUTSIDE_MONTH_OPACITY =
  parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--outside-opacity")) || 0.45;

const DEFAULT_SETTINGS = {
  p1Name: "Papa",
  p2Name: "Mama",
  p1Color: "#a3cf8f",
  p2Color: "#f7dd86",
};

// The two owner fills come from a free-choice <input type="color"> (any of
// 16M hex values, see Einstellungen), so the day number/note-dot/today-ring
// drawn on top of a fill can't stay legible with one hardcoded dark ink —
// it has to be picked per fill. DARK_INK/LIGHT_INK are the only two inks we
// ever use; inkFor() below picks whichever gives higher WCAG contrast
// against a given fill.
const DARK_INK = "#1c1c1e";
const LIGHT_INK = "#ffffff";

function hexToRgb(hex) {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) {
    h = h.split("").map((c) => c + c).join("");
  }
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function relativeLuminance({ r, g, b }) {
  const srgb = [r, g, b].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

function contrastRatio(lumA, lumB) {
  const [lighter, darker] = lumA >= lumB ? [lumA, lumB] : [lumB, lumA];
  return (lighter + 0.05) / (darker + 0.05);
}

/** Whichever of DARK_INK/LIGHT_INK reads better (WCAG contrast) on top of `fillHex`. */
function inkFor(fillHex) {
  const fillLum = relativeLuminance(hexToRgb(fillHex));
  const darkContrast = contrastRatio(fillLum, relativeLuminance(hexToRgb(DARK_INK)));
  const lightContrast = contrastRatio(fillLum, relativeLuminance(hexToRgb(LIGHT_INK)));
  return darkContrast >= lightContrast ? DARK_INK : LIGHT_INK;
}

/** The ink to put on top of an inkFor(...)-colored surface itself (e.g. the digit inside the today-ring) — inkFor() only ever returns one of two fixed constants, so its "on" color is simply the other one. */
function inkOn(ink) {
  return ink === DARK_INK ? LIGHT_INK : DARK_INK;
}

/** Recomputes --p1-ink/--p2-ink (+ their "-on" counterparts for the today-ring digit) from the currently committed owner colors and pushes them onto the document, so painted-cell text stays legible no matter which hex the color wells picked. */
function applyInkVars() {
  const root = document.documentElement.style;
  const p1Ink = inkFor(state.settings.p1Color);
  const p2Ink = inkFor(state.settings.p2Color);
  root.setProperty("--p1-ink", p1Ink);
  root.setProperty("--p1-ink-on", inkOn(p1Ink));
  root.setProperty("--p2-ink", p2Ink);
  root.setProperty("--p2-ink-on", inkOn(p2Ink));
}

const state = {
  displayedMonth: startOfMonth(new Date()),
  entries: {},
  notes: {},
  // For "both" days: which brush ("p1" or "p2") was already on the day
  // before the tap that combined it, so that color stays on the left/first
  // side of the diagonal split.
  splitOrder: {},
  settings: { ...DEFAULT_SETTINGS },
  activeBrush: "p1",
};

// Set while a long-press note-dialog is open, so the click event that
// follows the release on touch devices doesn't also cycle the brush color.
let noteEditingDate = null;
let longPressTimer = null;
let longPressFired = false;

// Whether the "Mehrfachauswahl" toggle is on; while it is, day-cell drags
// paint instead of the viewport treating horizontal motion as a month swipe.
let paintModeActive = false;
// Set for the duration of one pointer press-and-maybe-drag in paint mode.
// `committed` flips true once the movement threshold is crossed, at which
// point `owner` (decided once, from the first cell) is locked in; a press
// that never crosses the threshold stays uncommitted and is left for the
// normal click handler to treat as a plain tap.
let paintDrag = null;

// In-memory only — an undo history doesn't need to survive a reload, and
// persisting it would mean reconciling it with edits made elsewhere (backup
// restore, another tab) between sessions.
// Each entry is a *batch*: the list of per-date records for one user
// gesture, so undoLastAction() reverts a whole tap or a whole paint drag in
// one step instead of one cell at a time.
let undoStack = [];
const UNDO_STACK_LIMIT = 20;

// Set for the duration of one paint drag so every cell it touches lands in
// the same undo batch; null outside a drag, when pushUndoRecord() commits
// each record as its own single-record batch (a plain tap).
let currentUndoBatch = null;

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

function parseDateKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
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

const HANDOVER_HORIZON_DAYS = 60;

/**
 * Only a switch into "p1" or "p2" counts as an announceable handover: a run
 * of unfilled days ahead just means nobody's scheduled it yet (not a real
 * switch), and a move into "both" is custody becoming shared rather than one
 * parent taking sole charge. A move *out of* "both" (or out of "none") into
 * a single person does count, since that's the moment someone takes over.
 */
function findNextHandover(fromDate) {
  // Track the previous day's owner (not just today's), so a switch back to
  // today's parent after a shared/unfilled stretch still counts as a handover.
  let prevOwner = ownerAt(fromDate);
  for (let i = 1; i <= HANDOVER_HORIZON_DAYS; i++) {
    const date = addDays(fromDate, i);
    const owner = ownerAt(date);
    if ((owner === "p1" || owner === "p2") && owner !== prevOwner) {
      return { date, fromOwner: prevOwner, toOwner: owner };
    }
    // Skip "none" days: a gap shouldn't reset who the last real owner was.
    if (owner !== "none") prevOwner = owner;
  }
  return null;
}

function formatHandoverDate(date) {
  return date.toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short" });
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
    const parsed = raw ? JSON.parse(raw) : fallback;
    // A literal "null"/number/array/etc is valid JSON but not a usable map, so
    // fall back rather than handing e.g. null or [] on to the owner migration.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(stateKey) {
  localStorage.setItem(JSON_FIELDS[stateKey], JSON.stringify(state[stateKey]));
}

// Only these hold owner values ("mine"/"ex"/"p1"/"p2"); notes are free-form
// user text and must not be run through the owner migration below.
const OWNER_MAP_FIELDS = new Set(["entries", "splitOrder"]);

// One-time migration from the original "mine"/"ex" naming to the neutral
// "p1"/"p2" scheme, so a calendar already filled in before this rename
// keeps working instead of losing its data.
function migrateLegacyOwner(value) {
  if (value === "mine") return "p1";
  if (value === "ex") return "p2";
  return value;
}

const VALID_OWNERS = new Set(["p1", "p2", "both"]);

function migrateLegacyOwnerMap(map) {
  const migrated = {};
  for (const [key, value] of Object.entries(map)) {
    const owner = migrateLegacyOwner(value);
    // Drop anything else (corrupt/hand-edited backup) instead of letting it
    // reach classList.add later, where a stray space would throw and brick render().
    if (VALID_OWNERS.has(owner)) {
      // defineProperty (not migrated[key] = owner) so a "__proto__" key from
      // an imported backup lands as a plain own property instead of invoking
      // the accessor and re-parenting `migrated` into an undeletable entry.
      Object.defineProperty(migrated, key, { value: owner, writable: true, enumerable: true, configurable: true });
    }
  }
  return migrated;
}

const LEGACY_SETTINGS_KEYS = {
  mineName: "p1Name",
  exName: "p2Name",
  mineColor: "p1Color",
  exColor: "p2Color",
};

const HEX_COLOR_RE = /^#[0-9a-f]{3,8}$/i;

const OTHER_OWNER_COLOR_KEY = { p1Color: "p2Color", p2Color: "p1Color" };

// Below this Euclidean RGB distance (max ~441.7), two owner colors read as
// "the same" at a glance -- and colour is the *only* thing distinguishing
// Person 1 from Person 2 anywhere in the UI (grid cells, stat dots, brush
// dots, the diagonal "both" split), so anything this close makes those
// undecodable.
const MIN_OWNER_COLOR_DISTANCE = 60;

function colorDistance(hexA, hexB) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

function rgbToHex({ r, g, b }) {
  return (
    "#" +
    [r, g, b]
      .map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0"))
      .join("")
  );
}

// If `hex` is too close to `otherHex` to stay visually distinguishable,
// nudge it to its RGB inverse (guaranteed far away in color space), falling
// back to whichever of black/white is furthest from `otherHex` for the rare
// case where a color sits close to its own inverse (grays).
function resolveOwnerColorCollision(hex, otherHex) {
  if (colorDistance(hex, otherHex) >= MIN_OWNER_COLOR_DISTANCE) return hex;
  const rgb = hexToRgb(hex);
  const inverted = rgbToHex({ r: 255 - rgb.r, g: 255 - rgb.g, b: 255 - rgb.b });
  if (colorDistance(inverted, otherHex) >= MIN_OWNER_COLOR_DISTANCE) return inverted;
  return colorDistance("#000000", otherHex) >= colorDistance("#ffffff", otherHex) ? "#000000" : "#ffffff";
}

// Settings can come from localStorage or an imported backup file, both of
// which a hand-edited/malicious file fully controls. Colors flow straight
// into CSS custom properties (styles.css), so anything other than a plain
// hex value (e.g. "url(https://evil.example/x)") would let a poisoned file
// turn the offline app into a network beacon on every render. Reset
// anything that isn't a valid hex color back to the default instead of
// trusting the file.
function sanitizeSettings(settings) {
  for (const key of ["p1Color", "p2Color"]) {
    if (typeof settings[key] !== "string" || !HEX_COLOR_RE.test(settings[key])) {
      settings[key] = DEFAULT_SETTINGS[key];
    }
  }
  // A hand-edited file (or one written before this check existed) can carry
  // two identical/near-identical owner colors, which is just as undecodable
  // as picking them live in the settings dialog -- resolve it the same way.
  settings.p2Color = resolveOwnerColorCollision(settings.p2Color, settings.p1Color);
  for (const key of ["p1Name", "p2Name"]) {
    settings[key] = String(settings[key] ?? "").trim() || DEFAULT_SETTINGS[key];
  }
  return settings;
}

function loadState() {
  for (const [stateKey, storageKey] of Object.entries(JSON_FIELDS)) {
    const loaded = loadJSON(storageKey, {});
    state[stateKey] = OWNER_MAP_FIELDS.has(stateKey) ? migrateLegacyOwnerMap(loaded) : loaded;
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
      sanitizeSettings(state.settings);
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

// `null` stands in for "key was absent" — entries/splitOrder values are
// always non-empty strings, so it can't collide with a real prior value.
function pushUndoRecord(key) {
  const record = {
    key,
    prevEntry: Object.prototype.hasOwnProperty.call(state.entries, key) ? state.entries[key] : null,
    prevSplitOrder: Object.prototype.hasOwnProperty.call(state.splitOrder, key) ? state.splitOrder[key] : null,
  };
  if (currentUndoBatch) {
    currentUndoBatch.push(record);
    return;
  }
  undoStack.push([record]);
  if (undoStack.length > UNDO_STACK_LIMIT) {
    undoStack.shift();
  }
}

// Opens a batch so a run of setOwner() calls (one paint drag) lands in the
// undo stack as a single entry; must be paired with commitUndoBatch() once
// the gesture ends, however it ends (pointerup, or a forced mid-drag render).
function beginUndoBatch() {
  currentUndoBatch = [];
}

function commitUndoBatch() {
  if (currentUndoBatch === null) return;
  const batch = currentUndoBatch;
  currentUndoBatch = null;
  if (batch.length === 0) return;
  undoStack.push(batch);
  if (undoStack.length > UNDO_STACK_LIMIT) {
    undoStack.shift();
  }
}

// Every place that nulls or replaces paintDrag outside of endPaintDrag's own
// pointerup/pointercancel handling (a forced render, a long-press stealing
// the gesture, a second pointerdown before release) must go through here —
// otherwise a committed drag's undo batch never closes and currentUndoBatch
// wedges open, silently swallowing all undo history from then on.
function flushPaintDrag() {
  if (paintDrag && paintDrag.committed) {
    commitUndoBatch();
    saveJSON("entries");
    saveJSON("splitOrder");
  }
  paintDrag = null;
}

// Restores entries + splitOrder for every date in the popped batch together,
// since a single tap (or drag-painted cell) can change both at once (e.g.
// "both" -> "p2" also clears splitOrder) and reverting only one half would
// leave the diagonal-split bookkeeping wrong. A batch holds one record per
// date (paintCell dedupes touches within a drag), so order doesn't matter.
function undoLastAction() {
  if (undoStack.length === 0) return;
  const batch = undoStack.pop();
  // A batch's dates can be out of view by now (month navigation doesn't
  // touch undoStack) — jump back to the batch's month first, or the revert
  // would land invisibly on whatever month happens to be on screen.
  state.displayedMonth = startOfMonth(parseDateKey(batch[0].key));
  for (const { key, prevEntry, prevSplitOrder } of batch) {
    if (prevEntry === null) {
      delete state.entries[key];
    } else {
      state.entries[key] = prevEntry;
    }
    if (prevSplitOrder === null) {
      delete state.splitOrder[key];
    } else {
      state.splitOrder[key] = prevSplitOrder;
    }
  }
  saveJSON("entries");
  saveJSON("splitOrder");
  render();
}

/** Writes `owner` for one date, including the "both" splitOrder bookkeeping and undo tracking — no save/render, so drag-painting can call this per cell and only flush once. */
function setOwner(date, owner) {
  const key = dateKey(date);
  pushUndoRecord(key);
  if (owner === "none") {
    delete state.entries[key];
  } else {
    state.entries[key] = owner;
  }
  if (owner === "both") {
    // Combining to "both" always layers the active brush on top of the
    // other one — true for a single tap (COMBINE_TABLE only reaches "both"
    // from the non-active owner) and for drag-painting, where a cell can
    // jump straight from "none" to "both" with no prior owner of its own.
    // Deriving it from activeBrush instead of the cell's own prior state
    // keeps every cell touched by one drag on the same diagonal split.
    state.splitOrder[key] = state.activeBrush === "p1" ? "p2" : "p1";
  } else {
    delete state.splitOrder[key];
  }
}

/** A tap only ever changes the one tapped cell, so — unlike a month change or restore — it doesn't need render()'s full grid teardown; repainting that cell plus the chrome that depends on the entries (handover/stats/undo) is enough. */
function applyBrush(date, cell) {
  const key = dateKey(date);
  const current = state.entries[key] || "none";
  setOwner(date, nextOwner(current, state.activeBrush));
  saveJSON("entries");
  saveJSON("splitOrder");
  applyOwnerVisual(cell, date);
  refreshChrome();
}

function updateBrushActiveStyles() {
  const buttons = [
    [document.getElementById("p1Brush"), "p1", state.settings.p1Color],
    [document.getElementById("p2Brush"), "p2", state.settings.p2Color],
  ];
  for (const [btn, brush, color] of buttons) {
    const selected = state.activeBrush === brush;
    btn.setAttribute("aria-checked", selected ? "true" : "false");
    btn.tabIndex = selected ? 0 : -1;
    btn.style.background = selected ? `${color}33` : "";
  }
}

/** Textual equivalent of an owner's color, for aria-label — the color/split is otherwise the only cue for who has the child that day. */
function ownerLabelText(owner) {
  if (owner === "p1") return state.settings.p1Name;
  if (owner === "p2") return state.settings.p2Name;
  if (owner === "both") return `${state.settings.p1Name} und ${state.settings.p2Name}`;
  return "nicht zugeteilt";
}

/** First letter of a person's name, upper-cased, for the in-cell owner glyph (falls back to "?" for an empty name). */
function ownerInitial(name) {
  return (String(name || "").trim().charAt(0) || "?").toUpperCase();
}

/** Visible, non-color cue for who owns a day — a same-color viewer, grayscale display or B&W print still needs a way to tell owners apart (WCAG 1.4.1), so this renders the owner's initial(s) in the cell alongside the fill color. */
function ownerGlyph(owner) {
  if (owner === "p1") return ownerInitial(state.settings.p1Name);
  if (owner === "p2") return ownerInitial(state.settings.p2Name);
  if (owner === "both") return `${ownerInitial(state.settings.p1Name)}${ownerInitial(state.settings.p2Name)}`;
  return "";
}

/** Applies owner-dependent classes/colors to an already-built cell — reused to repaint a cell live during a paint drag without rebuilding the whole grid. Also (re)builds the aria-label, since ownership and note presence are otherwise conveyed only by color/opacity and a bare dot. */
function applyOwnerVisual(cell, date) {
  cell.classList.remove("p1", "p2", "both");
  const { owner, split, hasNote, key } = describeCell(date);
  if (owner !== "none") {
    cell.classList.add(owner);
  }
  if (split) {
    cell.style.setProperty("--cell-first", split.first);
    cell.style.setProperty("--cell-second", split.second);
    // The diagonal split's ink can't come from the global --p1-ink/--p2-ink:
    // .note-dot sits over the base fill (--cell-first) and .num sits over
    // the overlay triangle (--cell-second, see styles.css), and either one
    // can be either owner's color depending on splitOrder — so each side's
    // ink has to be computed straight from that side's own actual fill.
    cell.style.setProperty("--cell-first-ink", inkFor(split.first));
    const secondInk = inkFor(split.second);
    cell.style.setProperty("--cell-second-ink", secondInk);
    cell.style.setProperty("--cell-second-ink-on", inkOn(secondInk));
  } else {
    cell.style.removeProperty("--cell-first");
    cell.style.removeProperty("--cell-second");
    cell.style.removeProperty("--cell-first-ink");
    cell.style.removeProperty("--cell-second-ink");
    cell.style.removeProperty("--cell-second-ink-on");
  }
  // Non-color cue for ownership (WCAG 1.4.1): the fill color alone doesn't
  // survive a color-vision deficiency, a washed-out display or B&W print, so
  // paint the owner's initial(s) on top of it too. aria-hidden since the
  // cell's own aria-label already announces the owner in full.
  let mark = cell.querySelector(".owner-mark");
  if (owner === "none") {
    if (mark) mark.remove();
  } else {
    if (!mark) {
      mark = document.createElement("span");
      mark.className = "owner-mark";
      mark.setAttribute("aria-hidden", "true");
      cell.appendChild(mark);
    }
    mark.textContent = ownerGlyph(owner);
  }
  let label = `${formatFullDate(date)}, ${ownerLabelText(owner)}`;
  if (hasNote) label += `, Notiz: ${state.notes[key]}`;
  if (cell.classList.contains("outside")) label += ", anderer Monat";
  if (cell.classList.contains("today")) label += ", heute";
  cell.setAttribute("aria-label", label);
}

/** Builds a single day cell, styled but without the interactive listeners (added separately for the live grid). */
function buildDayCell(date, current) {
  const cell = document.createElement("button");
  cell.className = "day-cell";
  if (!current) {
    cell.classList.add("outside");
  }
  if (dateKey(date) === dateKey(new Date())) {
    cell.classList.add("today");
    cell.setAttribute("aria-current", "date");
  }
  const { key, hasNote } = describeCell(date);
  cell.dataset.date = key; // read back by paint-drag tracking, which finds cells via elementFromPoint rather than their own events
  // Documents the Space-to-open-note keyboard shortcut for assistive tech,
  // since it has no other discoverable affordance (see the keydown handler
  // wired up in render()).
  cell.setAttribute("aria-keyshortcuts", "Space");
  applyOwnerVisual(cell, date);
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

/**
 * Defers `fn` to its own task, off whatever handler scheduled it. Deliberately
 * a plain macrotask rather than requestIdleCallback: idle callbacks can be
 * delayed for many frames under any load, which would defeat pre-warming a
 * peek card for a swipe that starts moving right away; a fast follow-up task
 * still keeps the ~90-node build out of the handler that scheduled it.
 */
function deferToNextTask(fn) {
  setTimeout(fn, 0);
}

function render() {
  document.documentElement.style.setProperty("--p1-color", state.settings.p1Color);
  document.documentElement.style.setProperty("--p2-color", state.settings.p2Color);
  applyInkVars();

  document.getElementById("monthTitle").textContent = monthTitle(state.displayedMonth);
  document.getElementById("todayBtn").disabled =
    dateKey(state.displayedMonth) === dateKey(startOfMonth(new Date()));

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
  // Likewise, a paint drag holds a reference to its start cell — if
  // something forces a render mid-drag (normally render() only happens
  // *after* the drag's own pointerup), that reference would go stale.
  // Flush whatever was already painted so it isn't silently lost, then drop it.
  flushPaintDrag();

  const grid = document.getElementById("dayGrid");
  // grid.innerHTML = "" below destroys whichever day-cell button currently
  // has keyboard focus (e.g. after Escape-closing the note dialog opened
  // via Space), silently stranding focus at <body> (WCAG 2.4.3). Remember
  // which date was focused so it can be re-focused once the new cell for
  // that date exists.
  const focusedDate = document.activeElement?.closest?.(".day-cell")?.dataset.date;
  grid.innerHTML = "";
  grid.classList.toggle("paint-mode", paintModeActive);
  for (const { date, current } of buildMonthCells(state.displayedMonth)) {
    const cell = buildDayCell(date, current);

    cell.addEventListener("pointerdown", (event) => {
      // longPressTimer/longPressFired are shared across all cells; a second
      // finger touching down elsewhere must not steal that slot from (or
      // reset the swallow flag for) whichever press already owns it.
      if (!event.isPrimary) return;
      longPressFired = false;
      longPressTimer = setTimeout(() => {
        longPressFired = true;
        // The dialog is taking over this press; drop the pending drag so a
        // move afterwards doesn't flip this cell's color behind the modal.
        flushPaintDrag();
        openNoteDialog(date);
      }, 500);
      if (paintModeActive) {
        // A second pointerdown before the previous drag's pointerup (e.g. a
        // right-click while still holding the left button) would otherwise
        // clobber an already-committed paintDrag without ever closing it.
        flushPaintDrag();
        paintDrag = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          lastX: event.clientX,
          lastY: event.clientY,
          startCell: cell,
          date,
          owner: null,
          committed: false,
          touched: new Set(),
        };
      }
    });
    const cancelLongPress = (event) => {
      // Likewise, a second finger's release must not cancel the primary
      // press's still-pending timer.
      if (!event.isPrimary) return;
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };
    cell.addEventListener("pointerup", cancelLongPress);
    cell.addEventListener("pointerleave", cancelLongPress);
    cell.addEventListener("pointercancel", cancelLongPress);
    // Keyboard-only equivalent of the pointer long-press: a day cell is a
    // <button>, so Enter/Space would otherwise only ever reach applyBrush
    // via the synthetic click, leaving openNoteDialog completely
    // unreachable without a pointer (WCAG 2.1.1). Space is free to
    // repurpose here since the native click it would trigger is prevented;
    // Enter keeps behaving like a tap (applyBrush), Space opens the note.
    cell.addEventListener("keydown", (event) => {
      if (event.key === " " || event.key === "Spacebar") {
        event.preventDefault();
        openNoteDialog(date);
      }
    });
    cell.addEventListener("click", () => {
      if (longPressFired) {
        longPressFired = false;
        return;
      }
      applyBrush(date, cell);
    });

    grid.appendChild(cell);
  }

  if (focusedDate) {
    grid.querySelector(`[data-date="${focusedDate}"]`)?.focus();
  }

  refreshChrome();
}

/** The parts of render() that depend on entries/settings but not on the grid's own DOM — split out so a single-cell repaint (applyBrush) can refresh them without rebuilding all 42 cells. */
function refreshChrome() {
  // The handover chip always refers to "today" (the next real-world switch),
  // while the stats row below refers to whichever month is displayed — these
  // can be very different periods (e.g. browsing to next March). Word each
  // row so its time scope is explicit, and reserve the handover row's height
  // via a same-shaped placeholder (rather than collapsing it with
  // display:none) so the stats row doesn't shift depending on whether a
  // handover happens to exist right now.
  const handover = findNextHandover(new Date());
  const handoverRow = document.getElementById("handoverRow");
  const handoverPlaceholder = document.getElementById("handoverPlaceholder");
  if (handover) {
    const name = handover.toOwner === "p1" ? state.settings.p1Name : state.settings.p2Name;
    const color = handover.toOwner === "p1" ? state.settings.p1Color : state.settings.p2Color;
    handoverRow.style.display = "";
    handoverPlaceholder.style.display = "none";
    document.getElementById("handoverDot").style.background = color;
    document.getElementById("handoverLabel").textContent = `Wechsel zu ${name} am ${formatHandoverDate(handover.date)}`;
  } else {
    handoverRow.style.display = "none";
    handoverPlaceholder.style.display = "";
  }

  // The displayed month is already spelled out in #monthTitle right above
  // this row, so repeating it verbatim in every chip just adds redundant,
  // wrap-prone text — each chip only needs to state its own name/count.
  const stats = monthStats(state.displayedMonth);
  document.getElementById("p1StatDot").style.background = state.settings.p1Color;
  document.getElementById("p2StatDot").style.background = state.settings.p2Color;
  document.getElementById("p1StatLabel").textContent = `${state.settings.p1Name} ${formatNights(stats.p1)} Nächte`;
  document.getElementById("p2StatLabel").textContent = `${state.settings.p2Name} ${formatNights(stats.p2)} Nächte`;

  document.getElementById("p1Label").textContent = state.settings.p1Name;
  document.getElementById("p2Label").textContent = state.settings.p2Name;
  document.getElementById("p1Dot").style.background = state.settings.p1Color;
  document.getElementById("p2Dot").style.background = state.settings.p2Color;
  updateBrushActiveStyles();
  document.getElementById("undoBtn").disabled = undoStack.length === 0;
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
  ctx.font = "800 46px ui-rounded, \"SF Pro Rounded\", -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(monthTitle(state.displayedMonth), width / 2, headerH / 2);

  ctx.fillStyle = "#3a3a3f";
  ctx.fillRect(0, headerH, width, weekdayH);
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 20px ui-rounded, \"SF Pro Rounded\", -apple-system, BlinkMacSystemFont, sans-serif";
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
    ctx.font = "600 24px ui-rounded, \"SF Pro Rounded\", -apple-system, BlinkMacSystemFont, sans-serif";
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
  const dialog = document.getElementById("settingsDialog");
  dialog.showModal();
  // Avoid auto-focusing the name text input (default first-focusable
  // behaviour of showModal()), which would pop the mobile keyboard over
  // the backup/restore actions. Focus the dialog itself instead.
  dialog.focus();
}

// Only updates state.settings; does not save or render, so callers can
// commit several fields and pay for one save+render instead of one each.
// Returns whether the field's value actually changed, which both lets
// callers skip the save+render entirely and de-duplicates the "input"/
// "change" pair below (the second of the two is always a no-op commit).
function commitSettingField(settingsKey, inputId, fallback) {
  const input = document.getElementById(inputId);
  const value = input.value;
  let next = fallback ? value.trim() || fallback : value;
  const otherColorKey = OTHER_OWNER_COLOR_KEY[settingsKey];
  if (otherColorKey) {
    next = resolveOwnerColorCollision(next, state.settings[otherColorKey]);
    // Keep the color well's swatch honest about what actually got committed
    // when the pick got nudged away from a collision.
    if (next !== value) input.value = next;
  }
  if (next === state.settings[settingsKey]) return false;
  state.settings[settingsKey] = next;
  return true;
}

function wireSettingsInputs() {
  for (const { settingsKey, inputId, fallback } of SETTINGS_FIELDS) {
    const input = document.getElementById(inputId);
    // Saved on every keystroke/color pick, not just on dialog close: closing
    // a <dialog> relies on a "close" event that a background app-kill (e.g.
    // iOS suspending the PWA before the user's tap on "Fertig" is fully
    // processed) can skip entirely, which used to silently drop the change.
    const commit = () => {
      if (!commitSettingField(settingsKey, inputId, fallback)) return;
      saveSettings();
      // Not render(): settings never change which days are painted, so a
      // grid rebuild here is dead weight — the color wheel fires "input"
      // continuously while dragging, and render()'s innerHTML reset made
      // that visibly stutter even though the grid sits behind the modal.
      document.documentElement.style.setProperty("--p1-color", state.settings.p1Color);
      document.documentElement.style.setProperty("--p2-color", state.settings.p2Color);
      applyInkVars();
      refreshChrome();
    };
    // Some WebKit versions are inconsistent about firing "input" for
    // <input type="color">'s native swatch sheet — "change" is the one
    // event every browser reliably fires once a color is picked, so both
    // are bound rather than betting on just one.
    input.addEventListener("input", commit);
    input.addEventListener("change", commit);
  }
}

function closeSettings() {
  let changed = false;
  for (const { settingsKey, inputId, fallback } of SETTINGS_FIELDS) {
    if (commitSettingField(settingsKey, inputId, fallback)) changed = true;
  }
  if (changed) {
    saveSettings();
    render();
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
  document.getElementById("noteDeleteBtn").hidden = !state.notes[dateKey(date)];
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
      window.alert("Sicherung gesendet.");
      return;
    } catch (err) {
      // AbortError means the user deliberately cancelled the share sheet:
      // cancel should mean cancel, not "download anyway".
      if (err.name === "AbortError") return;
      // Any other rejection is a genuine failure, fall through to the download link.
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "kinder-kalender-backup.json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  window.alert("Sicherung gespeichert.");
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
    const prevEntries = state.entries;
    const prevNotes = state.notes;
    const prevSplitOrder = state.splitOrder;
    const prevSettings = state.settings;

    state.entries = migrateLegacyOwnerMap(data.entries || {});
    // Unlike entries/splitOrder, notes aren't run through a migration map that
    // implicitly drops non-object input, so a bogus type (e.g. a bare number
    // or an array, which also passes typeof === "object") must be rejected
    // here, or it lands in state.notes and JSON.stringify later drops every
    // note written to it.
    state.notes =
      data.notes && typeof data.notes === "object" && !Array.isArray(data.notes) ? data.notes : {};
    state.splitOrder = migrateLegacyOwnerMap(data.splitOrder || {});
    state.settings = { ...state.settings, ...(data.settings || {}) };
    // Undo records reference pre-restore values by key; replaying one now
    // would silently overwrite freshly restored data with stale state.
    undoStack = [];
    for (const [legacyKey, newKey] of Object.entries(LEGACY_SETTINGS_KEYS)) {
      if (data.settings && data.settings[legacyKey] !== undefined) {
        state.settings[newKey] = data.settings[legacyKey];
      }
    }
    sanitizeSettings(state.settings);
    try {
      saveJSON("entries");
      saveJSON("notes");
      saveJSON("splitOrder");
      saveSettings();
    } catch {
      // A backup that's merely well-formed JSON can still blow the localStorage
      // quota partway through these four writes; without rolling state back,
      // the in-memory data and localStorage would end up permanently out of
      // sync and every later save (e.g. the next applyBrush) would keep throwing.
      state.entries = prevEntries;
      state.notes = prevNotes;
      state.splitOrder = prevSplitOrder;
      state.settings = prevSettings;
      window.alert("Sicherung konnte nicht gespeichert werden (vermutlich zu groß für den verfügbaren Speicher).");
      render();
      return;
    }
    populateSettingsForm();
    // Close the dialog before rendering: its ::backdrop covers the whole
    // viewport, so leaving it open would hide the very calendar the restore
    // just updated, and the user would have no way to tell anything changed.
    document.getElementById("settingsDialog").close();
    render();
    window.alert("Sicherung wiederhergestellt.");
  };
  reader.readAsText(file);
}

function changeMonth(delta) {
  state.displayedMonth = addMonths(state.displayedMonth, delta);
  render();
}

// Small on purpose: unlike the swipe gesture, a paint drag isn't fighting
// over "horizontal vs. vertical", just "did the finger move at all" — it
// only needs to tell a real drag apart from finger jitter during a tap.
const PAINT_DRAG_THRESHOLD = 8;

// Comfortably smaller than a day-cell, so stepping the segment at this
// spacing can't jump clean over a cell even on a fast flick.
const PAINT_DRAG_STEP = 12;

function paintCell(cell, drag) {
  const key = cell.dataset.date;
  if (!key || drag.touched.has(key)) return;
  drag.touched.add(key);
  const date = parseDateKey(key);
  setOwner(date, drag.owner);
  applyOwnerVisual(cell, date);
}

/**
 * A fast flick can deliver `pointermove` samples several cells apart, e.g.
 * only Mo/Do/Su of a week — `elementFromPoint` on the sample alone would
 * leave the cells in between unpainted. Walking the segment from the last
 * sample to this one at sub-cell spacing visits every cell the pointer
 * crossed, same as if the browser had delivered one sample per cell.
 */
function paintAlongSegment(drag, x, y, startCell) {
  const steps = Math.max(1, Math.ceil(Math.hypot(x - drag.lastX, y - drag.lastY) / PAINT_DRAG_STEP));
  // Two passes so hit-testing never reads layout that a previous step's own
  // paint just dirtied — interleaving would force a fresh layout per cell.
  // `startCell` (the drag's origin, painted on the same move that commits
  // it) joins this batch too, since it's already known and needs no read.
  const cells = startCell ? [startCell] : [];
  for (let i = 1; i <= steps; i++) {
    const px = drag.lastX + ((x - drag.lastX) * i) / steps;
    const py = drag.lastY + ((y - drag.lastY) * i) / steps;
    const target = document.elementFromPoint(px, py);
    const cell = target && target.closest(".day-cell");
    if (cell) cells.push(cell);
  }
  for (const cell of cells) paintCell(cell, drag);
  drag.lastX = x;
  drag.lastY = y;
}

/** Locks in what this drag paints, decided once from the first cell — same rule a lone tap would have used (see nextOwner/COMBINE_TABLE). */
function commitPaintDrag() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  longPressFired = true; // swallow the click the start cell would otherwise get once the pointer is released elsewhere
  const key = dateKey(paintDrag.date);
  const current = state.entries[key] || "none";
  paintDrag.owner = nextOwner(current, state.activeBrush);
  paintDrag.committed = true;
  beginUndoBatch(); // whole drag undoes as one step, not one record per painted cell
  // Painting the start cell itself is left to the caller's paintAlongSegment
  // batch, not done here, so its write doesn't land ahead of that batch's reads.
}

/**
 * Tracks a paint drag once `pointerdown` on a day-cell has staged one (see
 * render()). Touch gives the pressed cell implicit pointer capture, so its
 * own `pointermove` won't fire for cells the finger passes over — instead
 * this listens on `document` and re-resolves the cell under the pointer via
 * `elementFromPoint` on every move, which also keeps working if the grid
 * happens to get rebuilt mid-drag (see the paintDrag guard in render()).
 */
function initPaintDragTracking() {
  document.addEventListener("pointermove", (event) => {
    if (!paintDrag || event.pointerId !== paintDrag.pointerId) return;
    let justCommitted = false;
    if (!paintDrag.committed) {
      const dx = event.clientX - paintDrag.startX;
      const dy = event.clientY - paintDrag.startY;
      if (Math.hypot(dx, dy) < PAINT_DRAG_THRESHOLD) return;
      commitPaintDrag();
      justCommitted = true;
    }
    paintAlongSegment(paintDrag, event.clientX, event.clientY, justCommitted ? paintDrag.startCell : null);
  });

  const endPaintDrag = (event) => {
    if (!paintDrag || event.pointerId !== paintDrag.pointerId) return;
    const wasCommitted = paintDrag.committed;
    flushPaintDrag();
    if (wasCommitted) {
      refreshChrome(); // cells are already repainted by applyOwnerVisual; only stats/handover/undo need it
    }
  };
  document.addEventListener("pointerup", endPaintDrag);
  document.addEventListener("pointercancel", endPaintDrag);
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

/** Jumps straight back to the month containing today, from however many months away — the "Heute" affordance. */
function goToToday() {
  const todayMonth = startOfMonth(new Date());
  if (dateKey(state.displayedMonth) === dateKey(todayMonth) || isViewportSliding()) return;
  const delta =
    (todayMonth.getFullYear() - state.displayedMonth.getFullYear()) * 12 +
    (todayMonth.getMonth() - state.displayedMonth.getMonth());
  slideToMonth(delta);
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
  let startPointerId = null;
  let isSwiping = false;
  let width = 0;
  let peekCard = null;
  let peekDelta = 0;
  let lastDx = 0;
  let cardHeight = 0;
  let peekHeight = 0;
  // Both neighbour cards (delta -1 and +1), keyed by delta, so a hesitant
  // drag that wobbles back and forth across its own start point reuses the
  // one it already built instead of tearing down and rebuilding a 42-cell
  // card on every direction flip.
  let peeks = {};
  // Which direction(s) a pre-warm has already been scheduled for during this
  // press, so a run of sub-threshold moves in the same direction doesn't
  // queue up a redundant deferred build per move.
  let prewarmedDeltas = new Set();

  // Builds one neighbour card, appends it (parked off-screen, since nothing
  // has positioned it yet) and caches it in `peeks`. Shared by ensurePeek's
  // build-on-demand fallback and the pre-warm in the pointermove handler
  // below, so there's one place that creates the ~90-node subtree and
  // measures it.
  const buildPeek = (delta) => {
    const built = buildCardContent(addMonths(state.displayedMonth, delta));
    built.classList.add("calendar-card--peek");
    built.style.transition = "none";
    // Rest it off-screen right away (same formula as positionSlide's
    // peekRestDx for dx=0) — the pre-warm runs before any drag calls
    // positionSlide itself, so without this it would briefly sit stacked on
    // top of the visible card instead of hidden past the edge.
    const restWidth = viewport.getBoundingClientRect().width;
    built.style.transform = `translateX(${delta > 0 ? restWidth : -restWidth}px)`;
    viewport.appendChild(built);
    const height = built.getBoundingClientRect().height; // measure once on build, not per move — content/height are fixed for this peek card
    const entry = { card: built, height };
    peeks[delta] = entry;
    return entry;
  };

  const ensurePeek = (delta) => {
    if (peekDelta === delta && peekCard) return;
    if (peekCard) positionSlide(card, peekCard, peekDelta, 0, width); // park the outgoing preview back at its resting edge instead of tearing it down
    peekDelta = delta;
    const entry = peeks[delta] || buildPeek(delta);
    peekCard = entry.card;
    peekHeight = entry.height;
  };

  // Drops the cached neighbour that lost out (if any), leaving only the one
  // the gesture actually committed to for slideToMonth/cancelSlide to remove.
  const discardOtherPeeks = (keepDelta) => {
    for (const [delta, cached] of Object.entries(peeks)) {
      if (Number(delta) !== keepDelta) cached.card.remove();
    }
    peeks = {};
  };

  // Drops every cached neighbour — used when a press ends without ever
  // becoming a swipe (a tap, or a long-press), so the pre-warm below doesn't
  // leave a card parked in the viewport forever with nothing to claim it.
  const discardAllPeeks = () => {
    for (const cached of Object.values(peeks)) cached.card.remove();
    peeks = {};
  };

  viewport.addEventListener("pointerdown", (event) => {
    if (isViewportSliding() || paintModeActive || startPointerId !== null) return; // a second finger touching down shouldn't hijack an in-progress gesture
    startPointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    isSwiping = false;
    prewarmedDeltas = new Set();
  });

  viewport.addEventListener("pointermove", (event) => {
    if (startX === null || event.pointerId !== startPointerId) return; // ignore other fingers while one gesture owns the drag
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!isSwiping) {
      // The very first few px already reveal which way this might go, well
      // before the 10px activation threshold. Pre-warm that direction's card
      // in a follow-up task now, so — for an actual swipe — it's already
      // built (and its height already measured) by the time the threshold
      // crosses, instead of paying for a ~90-node build + forced layout
      // inside that handler. Most presses are a tap or a vertical scroll and
      // never reach the threshold at all; those get cleaned up below
      // (discardAllPeeks) once the press ends without becoming a swipe.
      if (dx !== 0 && Math.abs(dx) > Math.abs(dy)) {
        const likelyDelta = dx < 0 ? 1 : -1;
        if (!prewarmedDeltas.has(likelyDelta)) {
          prewarmedDeltas.add(likelyDelta);
          const pressPointerId = startPointerId;
          deferToNextTask(() => {
            if (startPointerId !== pressPointerId) return; // this press already ended — the cache would just sit here unused
            if (!peeks[likelyDelta]) buildPeek(likelyDelta);
          });
        }
      }
      if (Math.abs(dx) <= 10 || Math.abs(dx) <= Math.abs(dy) * 1.5) return;
      isSwiping = true;
      try {
        viewport.setPointerCapture(event.pointerId); // keep receiving move/up even once the finger strays outside the card
      } catch {} // pointer already gone (rare race) — don't abort the drag setup below and leave width/height unmeasured
      viewport.classList.add("sliding");
      width = viewport.getBoundingClientRect().width;
      cardHeight = card.getBoundingClientRect().height; // measure once — the card's height can't change mid-drag
      viewport.style.height = `${cardHeight}px`; // pin explicit height so it can be animated instead of jumping
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
    const progress = Math.abs(clampedDx) / width;
    viewport.style.height = `${cardHeight + (peekHeight - cardHeight) * progress}px`;
    positionSlide(card, peekCard, peekDelta, clampedDx, width);
  });

  // Listen on document, not viewport: before the swipe threshold is crossed
  // there's no pointer capture yet, so a release over any other element
  // (e.g. dragged onto a footer button) would never reach a viewport-scoped
  // listener and would leave startPointerId stuck forever.
  document.addEventListener("pointerup", (event) => {
    if (event.pointerId !== startPointerId) return; // a second finger lifting shouldn't end someone else's gesture
    if (isSwiping) {
      const dx = Math.max(-width, Math.min(width, event.clientX - startX));
      discardOtherPeeks(peekDelta);
      // A stray extra pointer can move dx past the threshold in a direction
      // that doesn't match the tracked preview — drop it so slideToMonth's
      // fresh replacement doesn't leave it behind in the viewport.
      if (dx <= -SWIPE_THRESHOLD) {
        if (peekDelta !== 1) peekCard.remove();
        slideToMonth(1, dx, peekDelta === 1 ? peekCard : null);
      } else if (dx >= SWIPE_THRESHOLD) {
        if (peekDelta !== -1) peekCard.remove();
        slideToMonth(-1, dx, peekDelta === -1 ? peekCard : null);
      } else cancelSlide(dx, peekCard, peekDelta, width);
    } else discardAllPeeks(); // a tap/long-press never touched ensurePeek — drop whatever the pre-warm above may have built
    startX = null;
    startY = null;
    startPointerId = null;
    isSwiping = false;
    peekCard = null;
    peekDelta = 0;
    lastDx = 0;
  });

  document.addEventListener("pointercancel", (event) => {
    if (event.pointerId !== startPointerId) return;
    if (isSwiping) {
      discardOtherPeeks(peekDelta);
      cancelSlide(lastDx, peekCard, peekDelta, width);
    } else discardAllPeeks();
    startX = null;
    startY = null;
    startPointerId = null;
    isSwiping = false;
    peekCard = null;
    peekDelta = 0;
    lastDx = 0;
  });
}

/** First-run discoverability hint for the tap/long-press gestures (see the
 * "Notizen (Long-Press) sind nirgends auffindbar" review finding) — shown
 * until the user dismisses it once, same pattern as #paintModeHint but
 * persisted across sessions via localStorage instead of a live toggle. */
function initNotesHint() {
  const hint = document.getElementById("notesHint");
  hint.hidden = localStorage.getItem("kk.notesHintDismissed") === "1";
  document.getElementById("notesHintDismiss").addEventListener("click", () => {
    hint.hidden = true;
    localStorage.setItem("kk.notesHintDismissed", "1");
  });
}

function init() {
  loadState();
  render();
  initNotesHint();
  initSwipeNavigation();
  initPaintDragTracking();

  document.getElementById("prevMonth").addEventListener("click", () => {
    if (!isViewportSliding()) slideToMonth(-1);
  });
  document.getElementById("nextMonth").addEventListener("click", () => {
    if (!isViewportSliding()) slideToMonth(1);
  });
  document.getElementById("todayBtn").addEventListener("click", goToToday);

  document.getElementById("paintModeBtn").addEventListener("click", () => {
    paintModeActive = !paintModeActive;
    const btn = document.getElementById("paintModeBtn");
    btn.classList.toggle("active", paintModeActive);
    btn.setAttribute("aria-pressed", String(paintModeActive));
    document.getElementById("dayGrid").classList.toggle("paint-mode", paintModeActive);
    document.getElementById("paintModeHint").hidden = !paintModeActive;
  });
  document.getElementById("undoBtn").addEventListener("click", undoLastAction);

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
  document.querySelector(".brush-group").addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    // Only two radios exist, so any arrow/Home/End press simply moves
    // selection to the other one (roving tabindex + real selection change,
    // per the WAI-ARIA radiogroup keyboard pattern).
    state.activeBrush = state.activeBrush === "p1" ? "p2" : "p1";
    saveBrush();
    updateBrushActiveStyles();
    document.getElementById(state.activeBrush === "p1" ? "p1Brush" : "p2Brush").focus();
  });

  document.getElementById("settingsBtn").addEventListener("click", openSettings);
  wireSettingsInputs();
  document.getElementById("settingsDialog").addEventListener("close", closeSettings);
  document.getElementById("shareBtn").addEventListener("click", shareCalendar);

  document.getElementById("noteDialog").addEventListener("close", closeNoteDialog);
  // Löschen is destructive and instant (no undo support for notes), so
  // require an explicit confirmation before letting the submit close the
  // dialog and delete the note.
  document.getElementById("noteDeleteBtn").addEventListener("click", (event) => {
    if (!window.confirm("Notiz wirklich löschen?")) {
      event.preventDefault();
    }
  });
  document.getElementById("exportBtn").addEventListener("click", exportBackup);
  document.getElementById("restoreBtn").addEventListener("click", triggerRestore);
  document.getElementById("restoreInput").addEventListener("change", handleRestoreFile);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").then((registration) => {
      // iOS home-screen installs are slow to notice a changed sw.js on their
      // own — nudge an update check on every launch instead of waiting for
      // whatever interval WebKit decides on internally.
      registration.update().catch(() => {});
    }).catch(() => {});
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
