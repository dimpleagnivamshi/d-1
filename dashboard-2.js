const PLOT_MAX_POINTS = 100;
const STORAGE_KEY = "dashboard_2_charts_v3";

const DEFAULT_CHARTS = [
    { id: "c1", title: "P1 vs Time", x: "timestamp", y: "P1", color: "#16a34a", timeFormat: "seconds" },
    { id: "c2", title: "P2 vs Time", x: "timestamp", y: "P2", color: "#2563eb", timeFormat: "seconds" },
    { id: "c3", title: "dP vs Time", x: "timestamp", y: "dP", color: "#dc2626", timeFormat: "seconds" },
    { id: "c4", title: "RPM vs Time", x: "timestamp", y: "RPM", color: "#9333ea", timeFormat: "seconds" }
];

const COLOR_PALETTE = ["#16a34a", "#2563eb", "#dc2626", "#9333ea", "#ea580c", "#0891b2", "#db2777", "#65a30d"];

let dashboardCharts = loadLayout();
let dragSourceId = null;

function loadLayout() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return DEFAULT_CHARTS.slice();
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_CHARTS.slice();
    } catch (error) {
        return DEFAULT_CHARTS.slice();
    }
}

function saveLayout() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(dashboardCharts));
    } catch (error) {}
}

function nextColor() {
    return COLOR_PALETTE[dashboardCharts.length % COLOR_PALETTE.length];
}

function newChartId() {
    return "c" + Date.now() + Math.floor(Math.random() * 1000);
}

async function renderDashboard() {
    const container = document.getElementById("chartGrid");
    if (!container) return;
    container.innerHTML = "";

    dashboardCharts.forEach(cfg => container.appendChild(buildCard(cfg)));
    container.appendChild(buildAddCard());

    const historyRows = await getLastLoggedRows(PLOT_MAX_POINTS).catch(() => []);
    dashboardCharts.forEach(cfg => {
        createChart("chart_" + cfg.id, historyRows, {
            x: cfg.x,
            y: cfg.y,
            color: cfg.color,
            compact: true,
            title: null,
            timeFormat: cfg.timeFormat || "seconds",
            aggregate: true
        });
    });
}

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
    handle.textContent = "\u22EE\u22EE";

    const title = document.createElement("h2");
    title.textContent = cfg.title || axisLabel(cfg.y) + " vs " + axisLabel(cfg.x);

    const removeBtn = document.createElement("button");
    removeBtn.className = "card-remove";
    removeBtn.textContent = "\u00D7";
    removeBtn.addEventListener("click", () => {
        dashboardCharts = dashboardCharts.filter(c => c.id !== cfg.id);
        saveLayout();
        renderDashboard();
    });

    toolbar.appendChild(handle);
    toolbar.appendChild(title);
    toolbar.appendChild(removeBtn);

    const canvas = document.createElement("canvas");
    canvas.id = "chart_" + cfg.id;
    card.appendChild(toolbar);
    card.appendChild(canvas);
    return card;
}

function buildAddCard() {
    const card = document.createElement("div");
    card.className = "chart-card add-card";
    const button = document.createElement("button");
    button.className = "add-graph-btn";
    button.innerHTML = "+<span>Add Graph</span>";
    button.addEventListener("click", () => renderDashboard());
    card.appendChild(button);
    return card;
}

function onDragStart(event) { dragSourceId = this.dataset.id; this.classList.add("dragging"); }
function onDragOver(event) { event.preventDefault(); }
function onDrop(event) {
    event.preventDefault();
    const targetId = this.dataset.id;
    if (!dragSourceId || dragSourceId === targetId) return;
    const fromIndex = dashboardCharts.findIndex(c => c.id === dragSourceId);
    const toIndex = dashboardCharts.findIndex(c => c.id === targetId);
    const moved = dashboardCharts.splice(fromIndex, 1)[0];
    dashboardCharts.splice(toIndex, 0, moved);
    saveLayout();
    renderDashboard();
}
function onDragEnd() { this.classList.remove("dragging"); dragSourceId = null; }

function setLiveStatus(text, isLive) {
    const status = document.getElementById("liveStatus");
    if (status) {
        status.textContent = text;
        status.classList.toggle("live-on", isLive === true);
    }
}

function handleTick(newRow, totalCount) {
    dashboardCharts.forEach(cfg => appendPoint("chart_" + cfg.id, newRow, PLOT_MAX_POINTS));
    setLiveStatus("Device 2 Live — Active Worker: " + (newRow.activeDevice || "Unknown") + " (" + totalCount + " readings)", true);
}

async function initLiveControls() {
    const downloadBtn = document.getElementById("downloadLog");
    try {
        const status = await getFeedStatus();
        setLiveStatus("Monitoring — " + status.count + " readings logged", true);
    } catch (error) {
        setLiveStatus("Backend unavailable", false);
    }

    if (downloadBtn) {
        downloadBtn.addEventListener("click", async () => {
            downloadBtn.disabled = true;
            try { await exportLogToExcel(); } catch (error) {} finally { downloadBtn.disabled = false; }
        });
    }
}

renderDashboard().then(() => {
    onRealtimeTick(handleTick);
    initLiveControls();
}).catch(err => console.error(err));