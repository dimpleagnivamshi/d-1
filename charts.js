const COLUMNS = [
    { key: "timestamp", label: "Timestamp", time: true },
    { key: "P1", label: "P1" },
    { key: "P2", label: "P2" },
    { key: "dP", label: "dP" },
    { key: "RPM", label: "RPM" },
    { key: "Flow", label: "Flow" },
    { key: "dP_SetpointDiff", label: "dP Setpoint Difference" },
    { key: "TCS_dP_P1_P2", label: "TCS dP P1 P2" },
    { key: "ConstDP", label: "Const dP" },
    { key: "ConstFlow", label: "Const Flow" }
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
    // time axis: sort by time. Any other X (Flow, Const Flow, ...): keep time order so the path is readable
    if (xKey === "timestamp") points.sort((a, b) => a.x - b.x);
    return points;
}

const chartRegistry = {};

/* Upper / lower limit lines: dotted horizontal lines drawn on the Y axis.
   The limits live on the chart object (chart.limits = { lower, upper }). */
const LIMIT_COLORS = { upper: "#dc2626", lower: "#d97706" };

const limitLinesPlugin = {
    id: "limitLines",
    afterDatasetsDraw: function (chart) {
        const area = chart.chartArea;
        const yScale = chart.scales && chart.scales.y;
        if (!area || !yScale || !chart.limits) return;
        [["upper", "Upper"], ["lower", "Lower"]].forEach(function (pair) {
            const value = chart.limits[pair[0]];
            if (!Number.isFinite(value)) return;
            const y = yScale.getPixelForValue(value);
            if (!(y >= area.top && y <= area.bottom)) return;     // outside the view: not drawn
            const ctx = chart.ctx;
            ctx.save();
            ctx.beginPath();
            ctx.setLineDash([1, 5]);                              // dot - dot - dot
            ctx.lineCap = "round";
            ctx.lineWidth = 2;
            ctx.strokeStyle = LIMIT_COLORS[pair[0]];
            ctx.moveTo(area.left, y);
            ctx.lineTo(area.right, y);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = LIMIT_COLORS[pair[0]];
            ctx.font = "11px sans-serif";
            ctx.textAlign = "right";
            ctx.fillText(pair[1] + " " + value, area.right - 4, pair[0] === "upper" ? y - 4 : y + 12);
            ctx.restore();
        });
    }
};

/* make the Y axis include the limit lines (unless fitData: then it stays on the data) */
function applyLimitBounds(chart, limits, fitData) {
    const y = chart.options.scales.y;
    const lo = limits && Number.isFinite(limits.lower) ? limits.lower : undefined;
    const hi = limits && Number.isFinite(limits.upper) ? limits.upper : undefined;
    if (!fitData && lo !== undefined) y.suggestedMin = lo; else delete y.suggestedMin;
    if (!fitData && hi !== undefined) y.suggestedMax = hi; else delete y.suggestedMax;
}

function setChartLimits(canvasId, limits, fitData) {
    const chart = chartRegistry[canvasId];
    if (!chart) return;
    chart.limits = {
        lower: limits && Number.isFinite(limits.lower) ? limits.lower : undefined,
        upper: limits && Number.isFinite(limits.upper) ? limits.upper : undefined
    };
    applyLimitBounds(chart, chart.limits, fitData);
    chart.update("none");
}

function createChart(canvasId, rows, settings) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    rows = rows || [];
    const xKey = settings.x || "timestamp";
    const yKey = settings.y;
    const compact = settings.compact === true;

    const points = buildPoints(rows, xKey, yKey);
    if (chartRegistry[canvasId]) chartRegistry[canvasId].destroy();

    const datasets = [{
        label: axisLabel(yKey),
        data: points,
        showLine: true,
        borderColor: settings.color || "#2563eb",
        backgroundColor: settings.color || "#2563eb",
        pointRadius: xKey === "timestamp" ? 0 : 3,
        pointHoverRadius: 5
    }];

    // optional dashed setpoint line (e.g. the const dP target drawn on the dP chart)
    if (settings.overlay && xKey === "timestamp") {
        datasets.push({
            label: axisLabel(settings.overlay) + " (setpoint)",
            overlayKey: settings.overlay,
            data: buildPoints(rows, xKey, settings.overlay),
            showLine: true,
            borderColor: "#64748b",
            backgroundColor: "#64748b",
            borderDash: [6, 4],
            borderWidth: 1.5,
            pointRadius: 0
        });
    }

    chartRegistry[canvasId] = new Chart(canvas, {
        type: "scatter",
        data: {
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    type: "linear",
                    title: { display: xKey !== "timestamp", text: axisLabel(xKey) },
                    ticks: {
                        callback: val => xKey === "timestamp" ? formatTimestamp(val, "seconds") : val
                    }
                },
                y: { title: { display: true, text: axisLabel(yKey) } }
            }
        },
        plugins: [limitLinesPlugin]
    });
    setChartLimits(canvasId, settings.limits, settings.fitData === true);
    chartRegistry[canvasId].xKey = xKey;
    chartRegistry[canvasId].yKey = yKey;
    return chartRegistry[canvasId];
}

function appendPoint(canvasId, row, maxPoints) {
    const chart = chartRegistry[canvasId];
    if (!chart) return;
    const xKey = chart.xKey || "timestamp";
    const yKey = chart.yKey || "P1";
    const x = xKey === "timestamp" ? new Date(row.timestamp).getTime() : Number(row[xKey]);
    const val = Number(row[yKey]);
    if (!Number.isFinite(x) || !Number.isFinite(val)) return;

    const data = chart.data.datasets[0].data;
    data.push({ x, y: val });
    if (maxPoints && data.length > maxPoints) data.shift();

    const overlay = chart.data.datasets[1];
    if (overlay && overlay.overlayKey && xKey === "timestamp") {
        const ov = Number(row[overlay.overlayKey]);
        if (Number.isFinite(ov)) {
            overlay.data.push({ x, y: ov });
            if (maxPoints && overlay.data.length > maxPoints) overlay.data.shift();
        }
    }

    // 'none' disables transition animations so the point plots instantly
    chart.update("none");
}