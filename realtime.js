const API_BASE_URL = window.location.origin;
const LIVE_PAGE_LIMIT = 5000;
let lastKnownReadingId = 0;
let knownReadingCount = 0;
let eventSource = null;
let streamConnecting = false;
let pollTimer = null;
let pollBusy = false;
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

async function startRealtimeFeed() {
    return apiRequest("/api/status");
}

async function stopRealtimeFeed() {
    return apiRequest("/api/status");
}

/* Delivers a row to every listener, once per id (shared by SSE and polling) */
function deliverRow(row) {
    if (!row || row.id <= lastKnownReadingId) return;
    lastKnownReadingId = row.id;
    knownReadingCount = row.id;
    tickListeners.forEach(fn => fn(row, knownReadingCount));
}

/* Polling fallback: works even when the host buffers the SSE stream */
function startPollingFallback() {
    if (pollTimer) return;
    pollTimer = setInterval(async function () {
        if (pollBusy) return;              // never overlap requests
        pollBusy = true;
        try {
            const result = await apiRequest("/api/readings?limit=30");
            result.rows.forEach(deliverRow);   // oldest -> newest, skips already-seen ids
        } catch (error) {
        } finally {
            pollBusy = false;
        }
    }, 1000);
}

function onRealtimeTick(callback) {
    tickListeners.push(callback);
    startPollingFallback();
    if (eventSource || streamConnecting) return;
    streamConnecting = true;

    const source = new EventSource(API_BASE_URL + "/api/stream");
    eventSource = source;

    source.addEventListener("reading", function (event) {
        try {
            deliverRow(JSON.parse(event.data));
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