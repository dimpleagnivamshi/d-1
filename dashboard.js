/* Device 1 (Master) dashboard.
   Loads history from the backend (Neon) and updates live over SSE.
   Also holds the "Interrupt Device 1" button, whose state follows the SERVER. */
const PLOT_MAX_POINTS = 100;
const STORAGE_KEY = "dashboard_charts_v3";

const DEFAULT_CHARTS = [
    { id: "c1", title: "P1 vs Time", x: "timestamp", y: "P1", color: "#2563eb", timeFormat: "seconds" },
    { id: "c2", title: "P2 vs Time", x: "timestamp", y: "P2", color: "#16a34a", timeFormat: "seconds" },
    { id: "c3", title: "dP vs Time", x: "timestamp", y: "dP", color: "#dc2626", timeFormat: "seconds" },
    { id: "c4", title: "RPM vs Time", x: "timestamp", y: "RPM", color: "#9333ea", timeFormat: "seconds" }
];

const COLOR_PALETTE = [
    "#2563eb", "#16a34a", "#dc2626", "#9333ea",
    "#ea580c", "#0891b2", "#db2777", "#65a30d"
];

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
            aggregate: true
        });
        if (cfg.x === "timestamp") {
            setChartPrecision("chart_" + cfg.id, cfg.timeFormat || "seconds");
        }
    });

    if (rows.length) lastPlottedId = rows[rows.length - 1].id;
}

function plotRow(row) {
    if (row.id <= lastPlottedId) return;
    lastPlottedId = row.id;
    dashboardCharts.forEach(function (cfg) {
        appendPoint("chart_" + cfg.id, row, PLOT_MAX_POINTS);
    });
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

function loadLayout() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return DEFAULT_CHARTS.slice();
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
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
            title: axisLabel(y) + " vs " + axisLabel(x),
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
        setLiveStatus("Live \u2014 Device 1 producing data (" + totalCount + " readings)", true);
    } else {
        isPlotting = false;   // chart stays frozen while Device 2 is active
        setLiveStatus("Device 1 interrupted \u2014 Device 2 is producing data (" + totalCount + " readings)", false);
    }
}

async function initLiveControls() {
    const downloadBtn = document.getElementById("downloadLog");

    await syncInterruptButton();

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