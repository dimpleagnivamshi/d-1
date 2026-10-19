/* Device 1 (Master) dashboard.
   Loads history from the backend (Neon) and updates live over SSE.
   Also holds the "Interrupt Device 1" button, whose state follows the SERVER. */
const PLOT_MAX_POINTS = 100;
const STORAGE_KEY = "dashboard_charts_v4";

const DEFAULT_CHARTS = [
    { id: "c1", title: "P1 vs Time", x: "timestamp", y: "P1", color: "#2563eb", timeFormat: "seconds" },
    { id: "c2", title: "P2 vs Time", x: "timestamp", y: "P2", color: "#16a34a", timeFormat: "seconds" },
    { id: "c3", title: "dP vs Time (dashed = dP setpoint)", x: "timestamp", y: "dP", color: "#dc2626", timeFormat: "seconds", overlay: "TCS_dP_P1_P2" },
    { id: "c4", title: "RPM vs Time", x: "timestamp", y: "RPM", color: "#9333ea", timeFormat: "seconds" },
    { id: "c5", title: "Flow vs Time", x: "timestamp", y: "Flow", color: "#0891b2", timeFormat: "seconds" }
];

const COLOR_PALETTE = [
    "#2563eb", "#16a34a", "#dc2626", "#9333ea",
    "#ea580c", "#0891b2", "#db2777", "#65a30d"
];

/* ASSUMED limits, drawn as dotted lines on the Y axis until you set your own
   (use the "Limits" button on a graph). They are not real alarm values. */
const LIMIT_DEFAULTS = {
    P1: { lower: 0.8, upper: 3.2 },                    // bar
    P2: { lower: 0.9, upper: 1.2 },                    // bar
    dP: { lower: 0.2, upper: 2.2 },                    // bar
    RPM: { lower: 900, upper: 2400 },                  // pump range 905 - 2395
    Flow: { lower: 400, upper: 2500 },                 // L/min
    dP_SetpointDiff: { lower: -0.05, upper: 0.05 },    // bar
    TCS_dP_P1_P2: { lower: 0, upper: 2.2 },            // bar
    ConstDP: { lower: 0, upper: 2 },
    ConstFlow: { lower: 0, upper: 2500 }
};

let modalEl = null;       // the open pop-up (graph table or limits), if any
let modalState = null;    // { refresh() } so an open table keeps updating live

let dashboardCharts = loadLayout();
let dragSourceId = null;
let d1_interrupted = false;

/* Only the ACTIVE device's page plots live. When this page becomes active it
   reloads the last points of the shared series, so it continues where the
   other device left off. */
const MY_DEVICE = "Device 1";
function isMine(row) {
    return String(row.activeDevice || "").startsWith(MY_DEVICE);
}

let isPlotting = false;
let rebuilding = false;
let pendingRows = [];
let lastPlottedId = 0;

async function refreshCharts() {
    const rows = await getLastLoggedRows(PLOT_MAX_POINTS).catch(function () {
        return [];
    });

    dashboardCharts.forEach(function (cfg) {
        createChart("chart_" + cfg.id, rows, {
            x: cfg.x,
            y: cfg.y,
            color: cfg.color,
            compact: true,
            title: null,
            timeFormat: cfg.timeFormat || "seconds",
            aggregate: true,
            overlay: cfg.overlay,
            limits: getLimits(cfg),
            fitData: cfg.fitData === true
        });
        if (cfg.x === "timestamp") {
            setChartPrecision("chart_" + cfg.id, cfg.timeFormat || "seconds");
        }
    });

    if (rows.length) lastPlottedId = rows[rows.length - 1].id;
    if (modalState && modalState.refresh) modalState.refresh();
}

function plotRow(row) {
    if (row.id <= lastPlottedId) return;
    lastPlottedId = row.id;
    dashboardCharts.forEach(function (cfg) {
        appendPoint("chart_" + cfg.id, row, PLOT_MAX_POINTS);
    });
    if (modalState && modalState.refresh) modalState.refresh();
}

/* =====================================================
   HELPERS (not present in charts.js)
   ===================================================== */

function formatByPrecision(ts, precision) {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    const pad = (n, l) => String(n).padStart(l || 2, "0");
    let h = d.getHours();
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    const date = pad(d.getDate()) + "-" + pad(d.getMonth() + 1) + "-" + d.getFullYear();
    const hh = pad(h);
    const mm = pad(d.getMinutes());
    const ss = pad(d.getSeconds());

    if (precision === "hours") return date + " " + hh + " " + ampm;
    if (precision === "minutes") return date + " " + hh + ":" + mm + " " + ampm;
    if (precision === "milliseconds") return date + " " + hh + ":" + mm + ":" + ss + "." + pad(d.getMilliseconds(), 3) + " " + ampm;
    return date + " " + hh + ":" + mm + ":" + ss + " " + ampm;
}

function setChartPrecision(canvasId, precision) {
    const chart = chartRegistry[canvasId];
    if (!chart) return;
    chart.options.scales.x.ticks.callback = function (val) {
        return formatByPrecision(val, precision);
    };
    chart.update("none");
}

function fillColumnSelect(selectId, opts) {
    const select = document.getElementById(selectId);
    if (!select) return;
    const includeTimestamp = !opts || opts.includeTimestamp !== false;
    select.innerHTML = "";
    COLUMNS.forEach(function (col) {
        if (col.key === "timestamp" && !includeTimestamp) return;
        const option = document.createElement("option");
        option.value = col.key;
        option.textContent = col.label;
        if (opts && opts.selected === col.key) option.selected = true;
        select.appendChild(option);
    });
}

/* =====================================================
   PERSISTENCE (localStorage) - layout only, not the data
   ===================================================== */

/* Saved graphs that plot the "Const Flow" setpoint are switched to the real Flow signal,
   and any duplicate Flow graph that results from that is dropped. */
function migrateLayout(list) {
    const seen = {};
    return list.map(function (c) {
        if (c.y !== "ConstFlow" && c.x !== "ConstFlow") return c;
        const x = c.x === "ConstFlow" ? "Flow" : c.x;
        const y = c.y === "ConstFlow" ? "Flow" : c.y;
        return Object.assign({}, c, {
            x: x,
            y: y,
            color: "#0891b2",
            title: y + " vs " + (x === "timestamp" ? "Time" : axisLabel(x))
        });
    }).filter(function (c) {
        const k = c.x + "|" + c.y;
        if (seen[k]) return false;
        seen[k] = true;
        return true;
    });
}

function loadLayout() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return DEFAULT_CHARTS.slice();
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return migrateLayout(parsed);
        return DEFAULT_CHARTS.slice();
    } catch (error) {
        console.error("Could not read saved dashboard layout", error);
        return DEFAULT_CHARTS.slice();
    }
}

function saveLayout() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(dashboardCharts));
    } catch (error) {
        console.error("Could not save dashboard layout", error);
    }
}

function nextColor() {
    return COLOR_PALETTE[dashboardCharts.length % COLOR_PALETTE.length];
}

function newChartId() {
    return "c" + Date.now() + Math.floor(Math.random() * 1000);
}

/* =====================================================
   RENDER THE GRID
   ===================================================== */

async function renderDashboard() {
    const container = document.getElementById("chartGrid");
    if (!container) return;

    container.innerHTML = "";

    dashboardCharts.forEach(function (cfg) {
        container.appendChild(buildCard(cfg));
    });

    container.appendChild(buildAddCard());

    await refreshCharts();
}

/* =====================================================
   ONE CHART CARD
   ===================================================== */

function buildCard(cfg) {
    const card = document.createElement("div");
    card.className = "chart-card";
    card.draggable = true;
    card.dataset.id = cfg.id;

    card.addEventListener("dragstart", onDragStart);
    card.addEventListener("dragover", onDragOver);
    card.addEventListener("drop", onDrop);
    card.addEventListener("dragend", onDragEnd);

    const toolbar = document.createElement("div");
    toolbar.className = "chart-card-toolbar";

    const handle = document.createElement("span");
    handle.className = "drag-handle";
    handle.title = "Drag to reorder";
    handle.textContent = "\u22EE\u22EE";

    const title = document.createElement("h2");
    title.textContent = cfg.title || axisLabel(cfg.y) + " vs " + axisLabel(cfg.x);

    const removeBtn = document.createElement("button");
    removeBtn.className = "card-remove";
    removeBtn.title = "Remove this graph";
    removeBtn.textContent = "\u00D7";
    removeBtn.addEventListener("click", function () {
        dashboardCharts = dashboardCharts.filter(function (c) {
            return c.id !== cfg.id;
        });
        saveLayout();
        renderDashboard();
    });

    toolbar.appendChild(handle);
    toolbar.appendChild(title);

    /* PRECISION CONTROL - only meaningful for timestamp X-axis */
    if (cfg.x === "timestamp") {
        const precisionRow = document.createElement("div");
        precisionRow.className = "card-precision-row";

        const precisionSelect = document.createElement("select");
        precisionSelect.className = "card-precision-select";
        precisionSelect.title = "Timestamp precision";

        ["hours", "minutes", "seconds", "milliseconds"].forEach(function (value) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = value.charAt(0).toUpperCase() + value.slice(1);
            if (value === (cfg.timeFormat || "seconds")) option.selected = true;
            precisionSelect.appendChild(option);
        });

        precisionSelect.addEventListener("change", function () {
            cfg.timeFormat = precisionSelect.value;
            setChartPrecision("chart_" + cfg.id, precisionSelect.value);
            saveLayout();
        });

        precisionRow.appendChild(precisionSelect);
        toolbar.appendChild(precisionRow);
    }

    const tools = document.createElement("div");
    tools.className = "card-tools";
    tools.appendChild(makeToolButton("Table", "Show the data of this graph as a table", function () { openTableModal(cfg); }));
    tools.appendChild(makeToolButton("Limits", "Set the lower / upper limit lines", function () { openLimitsModal(cfg); }));
    toolbar.appendChild(tools);

    toolbar.appendChild(removeBtn);

    const canvas = document.createElement("canvas");
    canvas.id = "chart_" + cfg.id;

    card.appendChild(toolbar);
    card.appendChild(canvas);

    return card;
}

/* =====================================================
   "+ ADD GRAPH" CARD
   ===================================================== */

function buildAddCard() {
    const card = document.createElement("div");
    card.className = "chart-card add-card";

    const button = document.createElement("button");
    button.className = "add-graph-btn";
    button.innerHTML = "+<span>Add Graph</span>";
    button.addEventListener("click", function () {
        openAddForm(card);
    });

    card.appendChild(button);
    return card;
}

function openAddForm(card) {
    card.innerHTML = "";
    card.classList.add("add-card-open");

    const form = document.createElement("div");
    form.className = "add-form";

    const xLabel = document.createElement("label");
    xLabel.textContent = "X-Axis";
    const xSelect = document.createElement("select");
    xSelect.id = "newChartX";

    const yLabel = document.createElement("label");
    yLabel.textContent = "Y-Axis";
    const ySelect = document.createElement("select");
    ySelect.id = "newChartY";

    const precisionWrap = document.createElement("div");
    precisionWrap.id = "newChartPrecisionWrap";
    precisionWrap.className = "precision-wrap";

    const precisionLabel = document.createElement("label");
    precisionLabel.textContent = "Timestamp Precision";

    const precisionSelect = document.createElement("select");
    precisionSelect.id = "newChartPrecision";

    ["hours", "minutes", "seconds", "milliseconds"].forEach(function (value) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value.charAt(0).toUpperCase() + value.slice(1);
        if (value === "seconds") option.selected = true;
        precisionSelect.appendChild(option);
    });

    precisionWrap.appendChild(precisionLabel);
    precisionWrap.appendChild(precisionSelect);

    form.appendChild(xLabel);
    form.appendChild(xSelect);
    form.appendChild(yLabel);
    form.appendChild(ySelect);
    form.appendChild(precisionWrap);

    const actions = document.createElement("div");
    actions.className = "add-form-actions";

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "btn-confirm";
    confirmBtn.textContent = "Add";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", renderDashboard);

    confirmBtn.addEventListener("click", function () {
        const x = xSelect.value;
        const y = ySelect.value;

        dashboardCharts.push({
            id: newChartId(),
            title: axisLabel(y) + " vs " + (x === "timestamp" ? "Time" : axisLabel(x)),
            x: x,
            y: y,
            color: nextColor(),
            timeFormat: precisionSelect.value
        });

        saveLayout();
        renderDashboard();
    });

    actions.appendChild(confirmBtn);
    actions.appendChild(cancelBtn);
    form.appendChild(actions);

    card.appendChild(form);

    fillColumnSelect("newChartX", { selected: "timestamp" });
    fillColumnSelect("newChartY", { includeTimestamp: false, selected: "P1" });

    function updatePrecisionVisibility() {
        precisionWrap.style.display = xSelect.value === "timestamp" ? "flex" : "none";
    }

    xSelect.addEventListener("change", updatePrecisionVisibility);
    updatePrecisionVisibility();
}

/* =====================================================
   DRAG & DROP REORDERING
   ===================================================== */

function onDragStart(event) {
    dragSourceId = this.dataset.id;
    this.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
}

function onDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    this.classList.add("drag-over");
}

function onDrop(event) {
    event.preventDefault();
    this.classList.remove("drag-over");

    const targetId = this.dataset.id;
    if (!dragSourceId || dragSourceId === targetId) return;

    const fromIndex = dashboardCharts.findIndex(function (c) { return c.id === dragSourceId; });
    const toIndex = dashboardCharts.findIndex(function (c) { return c.id === targetId; });
    if (fromIndex === -1 || toIndex === -1) return;

    const moved = dashboardCharts.splice(fromIndex, 1)[0];
    dashboardCharts.splice(toIndex, 0, moved);

    saveLayout();
    renderDashboard();
}

function onDragEnd() {
    this.classList.remove("dragging");
    document.querySelectorAll(".drag-over").forEach(function (el) {
        el.classList.remove("drag-over");
    });
    dragSourceId = null;
}

/* =====================================================
   DEVICE 1 INTERRUPT BUTTON - state comes from the server
   ===================================================== */

function renderInterruptButton() {
    const btn = document.getElementById("btn-interrupt-d1");
    if (!btn) return;
    btn.style.background = d1_interrupted ? "#dc2626" : "#ea580c";
    btn.innerText = d1_interrupted
        ? "Resume Device 1 (Currently Interrupted)"
        : "Interrupt Device 1 (Master)";
}

async function syncInterruptButton() {
    try {
        const s = await getFeedStatus();
        d1_interrupted = !s.device1Active;
        renderInterruptButton();
    } catch (e) {
        console.error("Could not sync interrupt button:", e);
    }
}

async function toggleInterrupt(device) {
    if (device !== "d1") return;
    try {
        const res = await fetch("/api/device1/interrupt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ interrupt: !d1_interrupted })
        });
        const result = await res.json();
        d1_interrupted = Boolean(result.interrupted); // trust the server, not a local guess
        renderInterruptButton();
    } catch (err) {
        console.error("Failed to toggle interrupt:", err);
    }
}

/* =====================================================
   LIVE FEED
   ===================================================== */

function setLiveStatus(text, isLive) {
    const status = document.getElementById("liveStatus") || document.getElementById("status");
    if (status) {
        status.textContent = text;
        status.classList.toggle("live-on", isLive === true);
    }
}

async function handleTick(newRow, totalCount) {
    appendLogRow(newRow);   // the Logs table shows every reading, whichever device produced it
    if (rebuilding) {
        if (isMine(newRow)) pendingRows.push(newRow);
        return;
    }

    if (isMine(newRow)) {
        if (!isPlotting) {
            // just became active: reload the shared history, then continue from it
            isPlotting = true;
            rebuilding = true;
            try { await refreshCharts(); } finally { rebuilding = false; }
            pendingRows.forEach(plotRow);
            pendingRows = [];
        }
        plotRow(newRow);
        setLiveStatus("Live \u2014 Device 1 producing data \u2014 " + (newRow.ControlMode || "") + " (" + totalCount + " readings)", true);
    } else {
        isPlotting = false;   // chart stays frozen while Device 2 is active
        setLiveStatus("Device 1 interrupted \u2014 Device 2 is producing data (" + totalCount + " readings)", false);
    }
}

async function initLiveControls() {
    const downloadBtn = document.getElementById("downloadLog");

    await syncInterruptButton();
    initSetpointPanel();

    try {
        const status = await getFeedStatus();
        setLiveStatus("Live \u2014 " + status.count + " readings logged", true);
    } catch (error) {
        console.error("Could not read backend status:", error);
        setLiveStatus("Backend unavailable: " + error.message, false);
    }

    // keep the button correct even if another tab/device changes the state
    setInterval(syncInterruptButton, 3000);

    if (downloadBtn) {
        downloadBtn.addEventListener("click", async function () {
            downloadBtn.disabled = true;
            try {
                await exportLogToExcel();
            } catch (error) {
                console.error("Excel export failed:", error);
                setLiveStatus("Export failed: " + error.message, false);
            } finally {
                downloadBtn.disabled = false;
            }
        });
    }
}

/* =====================================================
   START
   ===================================================== */

renderDashboard().then(function () {
    onRealtimeTick(handleTick);
    initLiveControls();
}).catch(function (error) {
    console.error("Dashboard failed to load:", error);
    setLiveStatus("Dashboard load failed: " + error.message, false);
});

/* =====================================================
   MANUAL SETPOINT PANEL (const dP / const flow)
   ===================================================== */

function setSetpointMessage(text, isError) {
    const el = document.getElementById("spMsg");
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? "#dc2626" : "#16a34a";
}

function updateSetpointInputs() {
    const mode = document.getElementById("spMode").value;
    document.getElementById("spDpWrap").style.opacity = mode === "dp" ? "1" : "0.45";
    document.getElementById("spFlowWrap").style.opacity = mode === "flow" ? "1" : "0.45";
}

async function initSetpointPanel() {
    const modeEl = document.getElementById("spMode");
    const dpEl = document.getElementById("spDp");
    const flowEl = document.getElementById("spFlow");
    const applyBtn = document.getElementById("btnApplySetpoint");
    if (!modeEl || !dpEl || !flowEl || !applyBtn) return;

    try {
        const sp = await apiRequest("/api/setpoint");
        modeEl.value = sp.mode;
        dpEl.value = sp.constDp;
        flowEl.value = sp.constFlow;
        setSetpointMessage("Active: " + (sp.mode === "dp" ? "Const dP " + sp.constDp + " bar" : "Const Flow " + sp.constFlow + " L/min"), false);
    } catch (e) {
        setSetpointMessage("Could not load setpoint: " + e.message, true);
    }

    modeEl.addEventListener("change", updateSetpointInputs);
    updateSetpointInputs();

    applyBtn.addEventListener("click", async function () {
        applyBtn.disabled = true;
        try {
            const res = await fetch("/api/setpoint", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    mode: modeEl.value,
                    constDp: Number(dpEl.value),
                    constFlow: Number(flowEl.value)
                })
            });
            const result = await res.json();
            if (!res.ok) throw new Error(result.error || "Request failed");
            setSetpointMessage("Applied: " + (result.mode === "dp" ? "Const dP " + result.constDp + " bar" : "Const Flow " + result.constFlow + " L/min") + " \u2014 RPM is adjusting", false);
        } catch (e) {
            setSetpointMessage(e.message, true);
        } finally {
            applyBtn.disabled = false;
        }
    });
}

/* =====================================================
   GRAPHS / LOGS VIEW SWITCH + LOGS TABLE
   ===================================================== */

const LOG_FETCH_MAX = 500;          // newest readings kept in the table (the "Rows to show" box picks how many are drawn)

const LOG_COLUMNS = [
    { key: "id", label: "#", dec: 0 },
    { key: "timestamp", label: "Timestamp", time: true },
    { key: "P1", label: "P1", dec: 3 },
    { key: "P2", label: "P2", dec: 3 },
    { key: "dP", label: "dP", dec: 3 },
    { key: "RPM", label: "RPM", dec: 0 },
    { key: "Flow", label: "Flow", dec: 1 },
    { key: "dP_SetpointDiff", label: "dP Setpoint Difference", dec: 3 },
    { key: "TCS_dP_P1_P2", label: "TCS dP P1 P2", dec: 3 },
    { key: "ConstDP", label: "Const dP" },
    { key: "ConstFlow", label: "Const Flow" },
    { key: "ControlMode", label: "Mode", text: true },
    { key: "activeDevice", label: "Device", text: true }
];

let logLimit = 100;
let logRows = [];       // newest first
let lastLogId = 0;

function formatLogCell(col, row) {
    const v = row[col.key];
    if (v === undefined || v === null || v === "") return "\u2014";      // e.g. Const Flow is blank in Const dP mode
    if (col.time) return formatByPrecision(v, "seconds");
    if (col.text) return String(v);
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    return col.dec === undefined ? String(n) : n.toFixed(col.dec);
}

function buildLogRowElement(row) {
    const tr = document.createElement("tr");
    LOG_COLUMNS.forEach(function (col) {
        const td = document.createElement("td");
        const text = formatLogCell(col, row);
        td.textContent = text;
        if (!col.text && !col.time) td.className = "num";
        if (text === "\u2014") td.classList.add("dim");
        tr.appendChild(td);
    });
    return tr;
}

function buildLogHeader() {
    const head = document.getElementById("logHead");
    if (!head) return;
    const tr = document.createElement("tr");
    LOG_COLUMNS.forEach(function (col) {
        const th = document.createElement("th");
        th.textContent = col.label;
        if (!col.text && !col.time) th.className = "num";
        tr.appendChild(th);
    });
    head.innerHTML = "";
    head.appendChild(tr);
}

function updateLogCount() {
    const el = document.getElementById("logCount");
    if (!el) return;
    el.textContent = "Showing " + Math.min(logRows.length, logLimit) + " of the last " + logRows.length + " readings \u2014 newest first";
}

function renderLogTable() {
    const body = document.getElementById("logBody");
    if (!body) return;
    body.innerHTML = "";
    const frag = document.createDocumentFragment();
    logRows.slice(0, logLimit).forEach(function (row) {
        frag.appendChild(buildLogRowElement(row));
    });
    body.appendChild(frag);
    updateLogCount();
}

async function loadLogRows() {
    const rows = await getLastLoggedRows(LOG_FETCH_MAX).catch(function () { return []; });   // oldest -> newest
    const loadedLast = rows.length ? rows[rows.length - 1].id : 0;
    // keep any reading that arrived live while the history was loading
    const newer = logRows.filter(function (r) { return r.id > loadedLast; });
    logRows = newer.concat(rows.slice().reverse());
    lastLogId = Math.max(lastLogId, loadedLast);
    renderLogTable();
}

function appendLogRow(row) {
    if (!row || !(row.id > lastLogId)) return;
    lastLogId = row.id;
    logRows.unshift(row);
    if (logRows.length > LOG_FETCH_MAX) logRows.pop();

    const body = document.getElementById("logBody");
    if (!body) return;
    body.insertBefore(buildLogRowElement(row), body.firstChild);
    while (body.rows.length > logLimit) body.deleteRow(body.rows.length - 1);
    updateLogCount();
}

function showView(name) {
    const logs = name === "logs";
    document.getElementById("viewGraphs").hidden = logs;
    document.getElementById("viewLogs").hidden = !logs;
    document.getElementById("tabGraphs").classList.toggle("active", !logs);
    document.getElementById("tabLogs").classList.toggle("active", logs);
    if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
    // charts drawn while hidden have no size; fix that when they come back
    if (!logs) Object.keys(chartRegistry).forEach(function (id) { chartRegistry[id].resize(); });
}

function initViewTabs() {
    const tabGraphs = document.getElementById("tabGraphs");
    const tabLogs = document.getElementById("tabLogs");
    if (!tabGraphs || !tabLogs) return;
    tabGraphs.addEventListener("click", function () { showView("graphs"); });
    tabLogs.addEventListener("click", function () { showView("logs"); });
    window.addEventListener("hashchange", function () {
        showView(location.hash === "#logs" ? "logs" : "graphs");
    });
    showView(location.hash === "#logs" ? "logs" : "graphs");   // open straight on Logs with dashboard.html#logs
}

function initLogsView() {
    buildLogHeader();
    const limitEl = document.getElementById("logLimit");
    if (limitEl) {
        logLimit = Number(limitEl.value) || 100;
        limitEl.addEventListener("change", function () {
            logLimit = Number(limitEl.value) || 100;
            renderLogTable();
        });
    }
    loadLogRows();
}

initViewTabs();
initLogsView();

/* =====================================================
   LIMIT LINES + GRAPH TABLE (per graph)
   ===================================================== */

/* limits of one graph: its own saved values, else the assumed defaults. null = switched off. */
function getLimits(cfg) {
    const d = LIMIT_DEFAULTS[cfg.y] || {};
    const lower = cfg.lower === undefined ? d.lower : cfg.lower;
    const upper = cfg.upper === undefined ? d.upper : cfg.upper;
    return {
        lower: Number.isFinite(lower) ? lower : undefined,
        upper: Number.isFinite(upper) ? upper : undefined
    };
}

function makeToolButton(text, title, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tool-btn";
    btn.textContent = text;
    btn.title = title;
    btn.draggable = false;
    btn.addEventListener("click", function (event) {
        event.stopPropagation();
        onClick();
    });
    return btn;
}

/* ---------- pop-up window ---------- */

function onModalKey(event) {
    if (event.key === "Escape") closeModal();
}

function closeModal() {
    if (modalEl) modalEl.remove();
    modalEl = null;
    modalState = null;
    document.removeEventListener("keydown", onModalKey);
}

function openModal(title, bodyEl, state) {
    closeModal();
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.addEventListener("click", function (event) {
        if (event.target === overlay) closeModal();
    });

    const box = document.createElement("div");
    box.className = "modal-box";

    const head = document.createElement("div");
    head.className = "modal-head";
    const h = document.createElement("h3");
    h.textContent = title;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "modal-close";
    x.textContent = "\u00D7";
    x.title = "Close";
    x.addEventListener("click", closeModal);
    head.appendChild(h);
    head.appendChild(x);

    box.appendChild(head);
    box.appendChild(bodyEl);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    modalEl = overlay;
    modalState = state || null;
    document.addEventListener("keydown", onModalKey);
}

/* ---------- table of one graph ---------- */

function decimalsFor(key) {
    const col = LOG_COLUMNS.find(function (c) { return c.key === key; });
    return col ? col.dec : undefined;
}

function formatGraphValue(key, v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "\u2014";
    const dec = decimalsFor(key);
    return dec === undefined ? String(n) : n.toFixed(dec);
}

/* the points currently plotted on the graph, newest first */
function graphRowsFor(cfg) {
    const chart = chartRegistry["chart_" + cfg.id];
    if (!chart) return { rows: [], overlayKey: null };
    const main = chart.data.datasets[0].data;
    const second = chart.data.datasets[1];
    const overlayKey = second && second.overlayKey ? second.overlayKey : null;
    const overlayByX = new Map();
    if (overlayKey) second.data.forEach(function (p) { overlayByX.set(p.x, p.y); });
    const rows = main.map(function (p) { return { x: p.x, y: p.y, ov: overlayByX.get(p.x) }; });
    return { rows: rows.reverse(), overlayKey: overlayKey };
}

function limitStatus(y, limits) {
    if (Number.isFinite(limits.upper) && y > limits.upper) return "Above upper limit";
    if (Number.isFinite(limits.lower) && y < limits.lower) return "Below lower limit";
    return "OK";
}

/* header + body cells for the graph table and the Excel export, built once */
function buildGraphTable(cfg) {
    const data = graphRowsFor(cfg);
    return makeGraphTable(cfg, data.rows, data.overlayKey);
}

/* rows = [{ x, y, ov }] in the order they should appear */
function makeGraphTable(cfg, sourceRows, overlayKey) {
    const limits = getLimits(cfg);
    const hasLimits = Number.isFinite(limits.lower) || Number.isFinite(limits.upper);
    const head = [cfg.x === "timestamp" ? "Time" : axisLabel(cfg.x), axisLabel(cfg.y)];
    if (overlayKey) head.push(axisLabel(overlayKey) + " (setpoint)");
    if (hasLimits) head.push("Limit status");

    const rows = sourceRows.map(function (r) {
        const cells = [
            cfg.x === "timestamp" ? formatByPrecision(r.x, cfg.timeFormat || "seconds") : formatGraphValue(cfg.x, r.x),
            formatGraphValue(cfg.y, r.y)
        ];
        if (overlayKey) cells.push(formatGraphValue(overlayKey, r.ov));
        const status = hasLimits ? limitStatus(r.y, limits) : null;
        if (hasLimits) cells.push(status);
        return { cells: cells, bad: status !== null && status !== "OK" };
    });
    return { head: head, rows: rows, limits: limits };
}

function openTableModal(cfg) {
    const body = document.createElement("div");
    body.className = "modal-body";

    const bar = document.createElement("div");
    bar.className = "modal-bar";
    const note = document.createElement("span");
    note.className = "log-count";
    const xlsBtn = document.createElement("button");
    xlsBtn.type = "button";
    xlsBtn.className = "tool-btn";
    xlsBtn.textContent = "Download these rows";
    xlsBtn.title = "Excel file with exactly the rows shown here. Use Export for longer periods.";
    xlsBtn.addEventListener("click", function () {
        const problem = exportShownRows(cfg);
        if (problem) note.textContent = problem;
    });
    bar.appendChild(note);
    bar.appendChild(xlsBtn);

    const wrap = document.createElement("div");
    wrap.className = "log-table-wrap modal-table-wrap";
    const table = document.createElement("table");
    table.className = "log-table";
    wrap.appendChild(table);

    body.appendChild(bar);
    body.appendChild(wrap);

    function render() {
        const t = buildGraphTable(cfg);
        table.innerHTML = "";
        const thead = document.createElement("thead");
        const htr = document.createElement("tr");
        t.head.forEach(function (label, i) {
            const th = document.createElement("th");
            th.textContent = label;
            if (i > 0 && label !== "Limit status") th.className = "num";
            htr.appendChild(th);
        });
        thead.appendChild(htr);
        table.appendChild(thead);

        const tbody = document.createElement("tbody");
        const frag = document.createDocumentFragment();
        t.rows.forEach(function (r) {
            const tr = document.createElement("tr");
            r.cells.forEach(function (text, i) {
                const td = document.createElement("td");
                td.textContent = text;
                const isStatus = t.head[i] === "Limit status";
                if (i > 0 && !isStatus) td.className = "num";
                if (r.bad && (i === 1 || isStatus)) td.classList.add("out");
                tr.appendChild(td);
            });
            frag.appendChild(tr);
        });
        tbody.appendChild(frag);
        table.appendChild(tbody);

        const lim = t.limits;
        const limText = (Number.isFinite(lim.lower) || Number.isFinite(lim.upper))
            ? " \u2014 limits: " + (Number.isFinite(lim.lower) ? lim.lower : "none") + " to " + (Number.isFinite(lim.upper) ? lim.upper : "none")
            : "";
        note.textContent = t.rows.length + " points on the graph, newest first" + limText;
    }

    render();
    openModal((cfg.title || axisLabel(cfg.y) + " vs " + axisLabel(cfg.x)) + " \u2014 data table", body, { refresh: render });
}

/* ---------- choose the lower / upper limit ---------- */

function openLimitsModal(cfg) {
    const cur = getLimits(cfg);
    const body = document.createElement("div");
    body.className = "modal-body";

    const info = document.createElement("p");
    info.className = "log-count";
    info.textContent = "Dotted lines on the Y axis (" + axisLabel(cfg.y) + "). Leave a box empty for no line. "
        + "The starting values are assumed, so change them to your real limits.";
    body.appendChild(info);

    function field(labelText, value) {
        const label = document.createElement("label");
        label.className = "limit-field";
        label.textContent = labelText;
        const input = document.createElement("input");
        input.type = "number";
        input.step = "any";
        input.value = Number.isFinite(value) ? value : "";
        label.appendChild(input);
        body.appendChild(label);
        return input;
    }
    const upperInput = field("Upper limit", cur.upper);
    const lowerInput = field("Lower limit", cur.lower);

    const fitLabel = document.createElement("label");
    fitLabel.className = "limit-check";
    const fitInput = document.createElement("input");
    fitInput.type = "checkbox";
    fitInput.checked = cfg.fitData === true;
    fitLabel.appendChild(fitInput);
    fitLabel.appendChild(document.createTextNode(" Zoom the axis to the data (a limit line shows only when it is inside the view)"));
    body.appendChild(fitLabel);

    const msg = document.createElement("div");
    msg.className = "limit-msg";
    body.appendChild(msg);

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    function apply() {
        setChartLimits("chart_" + cfg.id, getLimits(cfg), cfg.fitData === true);
        saveLayout();
        closeModal();
    }

    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn-confirm";
    save.textContent = "Save";
    save.addEventListener("click", function () {
        const parse = function (el) {
            const t = el.value.trim();
            if (t === "") return { ok: true, value: null };
            const n = Number(t);
            return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
        };
        const up = parse(upperInput);
        const lo = parse(lowerInput);
        if (!up.ok || !lo.ok) { msg.textContent = "Enter numbers only."; return; }
        if (up.value !== null && lo.value !== null && lo.value >= up.value) {
            msg.textContent = "The lower limit must be smaller than the upper limit.";
            return;
        }
        cfg.upper = up.value;
        cfg.lower = lo.value;
        cfg.fitData = fitInput.checked;
        apply();
    });

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "btn-cancel";
    reset.textContent = "Reset to assumed values";
    reset.addEventListener("click", function () {
        delete cfg.upper;
        delete cfg.lower;
        delete cfg.fitData;
        apply();
    });

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", closeModal);

    actions.appendChild(save);
    actions.appendChild(reset);
    actions.appendChild(cancel);
    body.appendChild(actions);

    openModal("Limits \u2014 " + (cfg.title || axisLabel(cfg.y) + " vs " + axisLabel(cfg.x)), body, null);
}

/* =====================================================
   EXPORT BUTTON: pick a graph and a period, export every recorded reading
   ===================================================== */

const EXPORT_PERIODS = [
    { value: "1",    label: "Last 1 hour" },
    { value: "6",    label: "Last 6 hours" },
    { value: "12",   label: "Last 12 hours" },
    { value: "24",   label: "Last 1 day" },
    { value: "48",   label: "Last 2 days" },
    { value: "72",   label: "Last 3 days" },
    { value: "168",  label: "Last 1 week" },
    { value: "336",  label: "Last 2 weeks" },
    { value: "504",  label: "Last 3 weeks" },
    { value: "720",  label: "Last 1 month" },
    { value: "all",  label: "All recorded data" }
];
const EXPORT_PERIOD_KEY = "dashboard_export_period";

function graphTitle(cfg) {
    return cfg.title || axisLabel(cfg.y) + " vs " + (cfg.x === "timestamp" ? "Time" : axisLabel(cfg.x));
}

function graphFileBase(cfg) {
    return graphTitle(cfg).replace(/[^\w\-]+/g, "_").replace(/^_+|_+$/g, "") || "graph";
}

function periodLabel(value) {
    const p = EXPORT_PERIODS.find(function (x) { return x.value === value; });
    return p ? p.label : value;
}

/* write one table (and an optional "Info" sheet) to an Excel file; numbers stay numbers */
function writeGraphWorkbook(cfg, table, infoRows, fileSuffix) {
    const aoa = [table.head].concat(table.rows.map(function (r) {
        return r.cells.map(function (c) {
            const n = Number(c);
            return String(c).trim() !== "" && Number.isFinite(n) ? n : c;
        });
    }));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = table.head.map(function (h, i) {
        let w = String(h).length;
        table.rows.slice(0, 50).forEach(function (r) { w = Math.max(w, String(r.cells[i]).length); });
        return { wch: Math.min(w + 2, 40) };
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, graphTitle(cfg).replace(/[\[\]:*?\/\\]/g, " ").slice(0, 31));
    if (infoRows) {
        const info = XLSX.utils.aoa_to_sheet(infoRows);
        info["!cols"] = [{ wch: 30 }, { wch: 60 }];
        XLSX.utils.book_append_sheet(wb, info, "Info");
    }
    XLSX.writeFile(wb, graphFileBase(cfg) + (fileSuffix || "") + ".xlsx");
}

/* the rows shown in the "Table" pop-up (what is drawn on the graph) */
function exportShownRows(cfg) {
    if (graphRowsFor(cfg).rows.length === 0) return "\u201C" + graphTitle(cfg) + "\u201D has no data yet.";
    if (typeof XLSX === "undefined") return "The Excel library did not load. Check the connection and refresh the page.";
    try {
        writeGraphWorkbook(cfg, buildGraphTable(cfg), null, "");
        return null;
    } catch (err) {
        return "Export failed: " + err.message;
    }
}

function formatCount(n) {
    return Number(n).toLocaleString("en-US");
}

/* every recorded reading of the period, fetched from the server. Resolves with { ok, text } */
async function exportGraphPeriod(cfg, period) {
    if (typeof XLSX === "undefined") return { ok: false, text: "The Excel library did not load. Check the connection and refresh the page." };

    const params = new URLSearchParams({ x: cfg.x, y: cfg.y, hours: period });
    if (cfg.overlay) params.set("overlay", cfg.overlay);

    let data;
    try {
        const res = await fetch("/api/export?" + params.toString(), { cache: "no-store" });
        if (res.status === 404) return { ok: false, text: "The server has no export service yet. Update server.js and storage.js, then restart it." };
        if (!res.ok) return { ok: false, text: "The server could not prepare the export (error " + res.status + ")." };
        data = await res.json();
    } catch (err) {
        return { ok: false, text: "Could not reach the server: " + err.message };
    }

    if (!data.rows || data.rows.length === 0) return { ok: false, text: "No recorded data for \u201C" + graphTitle(cfg) + "\u201D in that period." };

    try {
        const rows = data.rows.map(function (r) { return { x: r[0], y: r[1], ov: r[2] }; });
        const table = makeGraphTable(cfg, rows, cfg.overlay || null);
        const averaged = data.bucketSeconds > 0;
        const fmt = function (ms) { return formatByPrecision(ms, "seconds"); };
        const info = [
            ["Graph", graphTitle(cfg)],
            ["Period", periodLabel(period)],
            ["First reading in file", fmt(data.firstMs)],
            ["Last reading in file", fmt(data.lastMs)],
            ["Readings recorded in period", data.total],
            ["Rows in this file", data.returned],
            ["Averaging", averaged ? "Each row is the average of " + data.bucketSeconds + " seconds of readings" : "None - every recorded reading is listed"],
            ["Exported at", fmt(Date.now())]
        ];
        writeGraphWorkbook(cfg, table, info, "_" + (period === "all" ? "all" : period + "h"));
        return {
            ok: true,
            text: "Exported " + formatCount(data.returned) + " rows" + (averaged ? " (averaged over " + data.bucketSeconds + " s from " + formatCount(data.total) + " readings)" : "") + "."
        };
    } catch (err) {
        return { ok: false, text: "Export failed: " + err.message };
    }
}

function initExportMenu() {
    const btn = document.getElementById("btnExportGraph");
    const menu = document.getElementById("exportMenu");
    if (!btn || !menu) return;

    let busy = false;

    function savedPeriod() {
        try {
            const v = localStorage.getItem(EXPORT_PERIOD_KEY);
            if (EXPORT_PERIODS.some(function (p) { return p.value === v; })) return v;
        } catch (e) { /* ignore */ }
        return "24";
    }

    function showMsg(text, ok) {
        const el = menu.querySelector(".export-msg");
        if (!el) return;
        el.textContent = text;
        el.classList.toggle("ok", ok === true);
    }

    function setBusy(flag) {
        busy = flag;
        menu.querySelectorAll("button, select").forEach(function (el) { el.disabled = flag; });
    }

    async function exportGraph(cfg, period) {
        if (busy) return;
        setBusy(true);
        showMsg("Preparing \u201C" + graphTitle(cfg) + "\u201D (" + periodLabel(period).toLowerCase() + ")\u2026 this can take a little while for long periods.", true);
        // let the message paint before the heavy work starts
        await new Promise(function (r) { setTimeout(r, 30); });
        const result = await exportGraphPeriod(cfg, period);
        setBusy(false);
        showMsg(result.text, result.ok);
    }

    function renderMenu() {
        menu.innerHTML = "";
        const head = document.createElement("div");
        head.className = "export-head";
        head.textContent = "Choose a graph and a period to export";
        menu.appendChild(head);

        dashboardCharts.forEach(function (cfg) {
            const row = document.createElement("div");
            row.className = "export-item";

            const name = document.createElement("span");
            name.className = "export-name";
            name.textContent = graphTitle(cfg);

            const select = document.createElement("select");
            select.className = "export-period";
            select.title = "How far back to export";
            EXPORT_PERIODS.forEach(function (p) {
                const o = document.createElement("option");
                o.value = p.value;
                o.textContent = p.label;
                select.appendChild(o);
            });
            select.value = savedPeriod();
            select.addEventListener("change", function () {
                try { localStorage.setItem(EXPORT_PERIOD_KEY, select.value); } catch (e) { /* ignore */ }
            });

            const btns = document.createElement("span");
            btns.className = "export-btns";
            btns.appendChild(makeToolButton("Excel", "Export every recorded reading of this graph for the chosen period", function () {
                exportGraph(cfg, select.value);
            }));

            row.appendChild(name);
            row.appendChild(select);
            row.appendChild(btns);
            menu.appendChild(row);
        });
        if (dashboardCharts.length === 0) {
            const empty = document.createElement("div");
            empty.className = "export-item";
            empty.textContent = "There are no graphs to export.";
            menu.appendChild(empty);
        }
        const msg = document.createElement("div");
        msg.className = "export-msg";
        menu.appendChild(msg);
    }

    btn.addEventListener("click", function (event) {
        event.stopPropagation();
        if (menu.hidden) { renderMenu(); menu.hidden = false; } else if (!busy) { menu.hidden = true; }
    });
    document.addEventListener("click", function (event) {
        if (!menu.hidden && !busy && !menu.contains(event.target)) menu.hidden = true;
    });
    document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && !busy) menu.hidden = true;
    });
}

initExportMenu();