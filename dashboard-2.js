/* Device 2 (Failover) dashboard.
   Plots only while Device 2 is the active producer; stays frozen while Device 1 is healthy.
   When it becomes active it reloads the shared history and continues from it. */
const PLOT_MAX_POINTS = 100;
const MY_DEVICE = "Device 2";

const CHARTS = [
    { id: "c1", y: "P1", color: "#2563eb", title: "P1 vs Time" },
    { id: "c2", y: "P2", color: "#16a34a", title: "P2 vs Time" },
    { id: "c3", y: "dP", color: "#dc2626", title: "dP vs Time (dashed = dP setpoint)", overlay: "TCS_dP_P1_P2" },
    { id: "c4", y: "RPM", color: "#9333ea", title: "RPM vs Time" },
    { id: "c5", y: "Flow", color: "#0891b2", title: "Flow vs Time" }
];

let isPlotting = false;
let rebuilding = false;
let pendingRows = [];
let lastPlottedId = 0;

function isMine(row) {
    return String(row.activeDevice || "").startsWith(MY_DEVICE);
}

function formatByPrecision(ts, precision) {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    const pad = (n, l) => String(n).padStart(l || 2, "0");
    let h = d.getHours();
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    const date = pad(d.getDate()) + "-" + pad(d.getMonth() + 1) + "-" + d.getFullYear();
    const hh = pad(h), mm = pad(d.getMinutes()), ss = pad(d.getSeconds());
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

function setLiveStatus(text, isLive) {
    const status = document.getElementById("liveStatus");
    if (status) {
        status.textContent = text;
        status.classList.toggle("live-on", isLive === true);
    }
}

function buildCard(cfg) {
    const card = document.createElement("div");
    card.className = "chart-card";

    const toolbar = document.createElement("div");
    toolbar.className = "chart-card-toolbar";
    const title = document.createElement("h2");
    title.textContent = cfg.title;
    toolbar.appendChild(title);

    const canvas = document.createElement("canvas");
    canvas.id = "chart_" + cfg.id;

    card.appendChild(toolbar);
    card.appendChild(canvas);
    return card;
}

async function refreshCharts() {
    const rows = await getLastLoggedRows(PLOT_MAX_POINTS).catch(function () { return []; });

    CHARTS.forEach(function (cfg) {
        createChart("chart_" + cfg.id, rows, {
            x: "timestamp",
            y: cfg.y,
            color: cfg.color,
            compact: true,
            title: null,
            timeFormat: "seconds",
            aggregate: true,
            overlay: cfg.overlay
        });
        setChartPrecision("chart_" + cfg.id, "seconds");
    });

    if (rows.length) lastPlottedId = rows[rows.length - 1].id;
}

function plotRow(row) {
    if (row.id <= lastPlottedId) return;
    lastPlottedId = row.id;
    CHARTS.forEach(function (cfg) {
        appendPoint("chart_" + cfg.id, row, PLOT_MAX_POINTS);
    });
}

async function renderDashboard() {
    const container = document.getElementById("chartGrid");
    if (!container) return;
    container.innerHTML = "";
    CHARTS.forEach(function (cfg) { container.appendChild(buildCard(cfg)); });
    await refreshCharts();
}

async function handleTick(newRow, totalCount) {
    if (rebuilding) {
        if (isMine(newRow)) pendingRows.push(newRow);
        return;
    }

    if (isMine(newRow)) {
        if (!isPlotting) {
            isPlotting = true;
            rebuilding = true;
            try { await refreshCharts(); } finally { rebuilding = false; }
            pendingRows.forEach(plotRow);
            pendingRows = [];
        }
        plotRow(newRow);
        setLiveStatus("Live \u2014 Device 2 (failover) producing data (" + totalCount + " readings)", true);
    } else {
        isPlotting = false;   // graph stays frozen while Device 1 is active
        setLiveStatus("Standby \u2014 Device 1 is healthy, Device 2 idle (" + totalCount + " readings)", false);
    }
}

async function initLiveControls() {
    const downloadBtn = document.getElementById("downloadLog");

    try {
        const status = await getFeedStatus();
        setLiveStatus(
            status.device1Active
                ? "Standby \u2014 Device 1 is healthy, Device 2 idle"
                : "Live \u2014 Device 2 (failover) producing data",
            !status.device1Active
        );
    } catch (error) {
        console.error("Could not read backend status:", error);
        setLiveStatus("Backend unavailable: " + error.message, false);
    }

    if (downloadBtn) {
        downloadBtn.addEventListener("click", async function () {
            downloadBtn.disabled = true;
            try { await exportLogToExcel(); }
            catch (error) {
                console.error("Excel export failed:", error);
                setLiveStatus("Export failed: " + error.message, false);
            } finally { downloadBtn.disabled = false; }
        });
    }
}

renderDashboard().then(function () {
    onRealtimeTick(handleTick);
    initLiveControls();
}).catch(function (error) {
    console.error("Dashboard failed to load:", error);
    setLiveStatus("Dashboard load failed: " + error.message, false);
});