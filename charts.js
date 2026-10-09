const COLUMNS = [
    { key: "timestamp", label: "Timestamp", time: true },
    { key: "P1", label: "P1" },
    { key: "P2", label: "P2" },
    { key: "dP", label: "dP" },
    { key: "RPM", label: "RPM" },
    { key: "dP_SetpointDiff", label: "dP Setpoint Difference" },
    { key: "TCS_dP_P1_P2", label: "TCS dP P1 P2" }
];

const COLUMN_LABELS = {};
COLUMNS.forEach(col => { COLUMN_LABELS[col.key] = col.label; });

function axisLabel(key, timeFormat) {
    if (key === "timestamp") return "Timestamp (" + (timeFormat || "minutes") + ")";
    return COLUMN_LABELS[key] || key;
}

function formatTimestamp(timestamp, precision) {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return null;
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const year = date.getFullYear();
    let hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12;
    return day + "-" + month + "-" + year + " " + String(hours).padStart(2, "0") + ":" + minutes + ":" + seconds + " " + ampm;
}

function buildPoints(rows, xKey, yKey) {
    const points = [];
    rows.forEach(row => {
        if (!row.timestamp) return;
        const x = xKey === "timestamp" ? new Date(row.timestamp).getTime() : Number(row[xKey]);
        const y = Number(row[yKey]);
        if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
    });
    points.sort((a, b) => a.x - b.x);
    return points;
}

const chartRegistry = {};

function createChart(canvasId, rows, settings) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    rows = rows || [];
    const xKey = settings.x || "timestamp";
    const yKey = settings.y;
    const compact = settings.compact === true;

    const points = buildPoints(rows, xKey, yKey);
    if (chartRegistry[canvasId]) chartRegistry[canvasId].destroy();

    chartRegistry[canvasId] = new Chart(canvas, {
        type: "scatter",
        data: {
            datasets: [{
                label: axisLabel(yKey),
                data: points,
                showLine: true,
                borderColor: settings.color || "#2563eb",
                backgroundColor: settings.color || "#2563eb",
                pointRadius: 0,
                pointHoverRadius: 5
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    type: "linear",
                    ticks: {
                        callback: val => xKey === "timestamp" ? formatTimestamp(val, "seconds") : val
                    }
                },
                y: { title: { display: true, text: axisLabel(yKey) } }
            }
        }
    });
    return chartRegistry[canvasId];
}

function appendPoint(canvasId, row, maxPoints) {
    const chart = chartRegistry[canvasId];
    if (!chart) return;
    const x = new Date(row.timestamp).getTime();
    const yKey = COLUMNS.find(c => c.label === chart.data.datasets[0].label)?.key || "P1";
    const val = Number(row[yKey]);
    if (!Number.isFinite(x) || !Number.isFinite(val)) return;

    const data = chart.data.datasets[0].data;
    data.push({ x, y: val });
    if (maxPoints && data.length > maxPoints) data.shift();
    
    // 'none' disables transition animations so the point plots instantly
    chart.update("none");
}