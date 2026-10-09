const API_BASE_URL = window.location.origin;
const LIVE_PAGE_LIMIT = 5000;
let lastKnownReadingId = 0;
let knownReadingCount = 0;
let eventSource = null;
let streamConnecting = false;
const tickListeners = [];

async function apiRequest(path, options) {
    const response = await fetch(API_BASE_URL + path, {
        headers: { "Accept": "application/json", ...(options && options.headers || {}) },
        ...options
    });
    if (!response.ok) throw new Error("API request failed (" + response.status + ")");
    return response.json();
}

async function getFeedStatus() {
    const status = await apiRequest("/api/status");
    knownReadingCount = status.count;
    return status;
}

async function getLastLoggedRows(limit) {
    const result = await apiRequest("/api/readings?limit=" + encodeURIComponent(limit || 100));
    if (result.rows.length) lastKnownReadingId = Math.max(lastKnownReadingId, result.rows[result.rows.length - 1].id);
    knownReadingCount = result.count;
    return result.rows;
}

async function getAllLoggedRows() {
    const result = await apiRequest("/api/readings?limit=5000");
    return result.rows;
}

function onRealtimeTick(callback) {
    tickListeners.push(callback);
    if (eventSource || streamConnecting) return;
    streamConnecting = true;

    const source = new EventSource(API_BASE_URL + "/api/stream");
    eventSource = source;

    source.addEventListener("reading", function (event) {
        try {
            const row = JSON.parse(event.data);
            if (row.id <= lastKnownReadingId) return;
            lastKnownReadingId = row.id;
            knownReadingCount += 1;
            tickListeners.forEach(fn => fn(row, knownReadingCount));
        } catch (error) {}
    });

    source.onerror = function () {
        streamConnecting = false;
        if (source.readyState === EventSource.CLOSED) eventSource = null;
    };
    source.onopen = function () { streamConnecting = false; };
}

async function exportLogToExcel() {
    if (typeof XLSX === "undefined") return;
    const rows = await getAllLoggedRows();
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Live Log");
    XLSX.writeFile(workbook, "live_sensor_log.xlsx");
}