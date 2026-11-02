const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = __dirname;

const mime = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8"
};

// Only these files can be downloaded by the browser (server code stays private)
const PUBLIC = new Set([
    "/index.html", "/dashboard.html", "/dashboard-2.html", "/pressure.html", "/style.css",
    "/pages.js", "/nav.js", "/charts.js", "/realtime.js", "/data.js", "/explorer.js",
    "/dashboard.js", "/dashboard-2.js", "/pressure.js"
]);

function loadConfig() {
    const envFile = path.resolve(projectRoot, ".env");
    if (fs.existsSync(envFile) && typeof process.loadEnvFile === "function") {
        process.loadEnvFile(envFile);
    }
    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required (set it in .env or the Voroa environment).");
    }
    return {
        host: (process.env.HOST || "0.0.0.0").trim(),
        port: Number(process.env.PORT || 3000)
    };
}

function send(res, status, body) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    });
    res.end(JSON.stringify(body));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", c => {
            data += c;
            if (data.length > 10000) { reject(new Error("Body too large")); req.destroy(); }
        });
        req.on("end", () => {
            try { resolve(data ? JSON.parse(data) : {}); }
            catch { reject(new Error("Invalid JSON")); }
        });
    });
}

async function handleApi(req, res, url, engine, stream, storage) {
    const p = url.pathname;

    if (req.method === "GET" && p === "/api/status") {
        return send(res, 200, await engine.getStatus());
    }
    if (req.method === "GET" && p === "/api/feed/status") {
        const s = await engine.getStatus();
        return send(res, 200, { running: s.device1Active });
    }
    if (req.method === "GET" && p === "/api/readings") {
        const limit = Number(url.searchParams.get("limit")) || 1000;
        const beforeId = url.searchParams.has("beforeId") ? Number(url.searchParams.get("beforeId")) : null;
        const afterId = url.searchParams.has("afterId") ? Number(url.searchParams.get("afterId")) : null;
        const rows = await storage.listReadings({ limit, beforeId, afterId });
        return send(res, 200, {
            rows,
            count: await storage.getReadingCount(),
            latestId: rows.length ? rows[rows.length - 1].id : 0
        });
    }
    if (req.method === "GET" && p === "/api/stream") {
        return stream.handle(req, res, url);
    }
    if (req.method === "GET" && p === "/api/setpoint") {
        return send(res, 200, engine.getControl());
    }
    if (req.method === "POST" && p === "/api/device1/interrupt") {
        let body;
        try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
        const status = await engine.setDevice1State(!body.interrupt);
        console.log("Device 1 interrupted:", !status.device1Active);
        return send(res, 200, { success: true, interrupted: !status.device1Active });
    }
    if (req.method === "POST" && p === "/api/setpoint") {
        let body;
        try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
        const result = await engine.setControl(body);
        if (!result.ok) return send(res, 400, { error: result.error });
        return send(res, 200, result.value);
    }

    // >>> If your OLD server.js had an Excel export route (using storage.exportSeries),
    // >>> copy it here, before "return false".

    return false;
}

function serveStatic(requestPath, res) {
    let decoded;
    try { decoded = decodeURIComponent(requestPath); }
    catch { res.writeHead(400); return res.end("Bad path"); }

    if (decoded === "/") decoded = "/dashboard.html";

    if (!PUBLIC.has(decoded)) { res.writeHead(404); return res.end("Not found"); }

    const file = path.join(projectRoot, decoded);
    const type = mime[path.extname(file).toLowerCase()];
    if (!type || !fs.existsSync(file)) { res.writeHead(404); return res.end("Not found"); }

    fs.readFile(file, (error, content) => {
        if (error) { res.writeHead(500); return res.end("Read error"); }
        res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
        res.end(content);
    });
}

async function main() {
    const config = loadConfig();
    const storage = require("./storage");
    const { FailoverEngine } = require("./generator");
    const { createStreamHub } = require("./stream");

    await storage.initializeStorage();
    const stream = createStreamHub(storage);
    const engine = new FailoverEngine(stream);
    await engine.init();
    engine.start();

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));

            if (req.method === "GET" && url.pathname === "/healthz") {
                return send(res, 200, { status: "ok" });
            }

            if (url.pathname.startsWith("/api/")) {
                // CORS: the page is served from this same server, so no cross-origin access is granted
                if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
                const handled = await handleApi(req, res, url, engine, stream, storage);
                if (handled !== false) return;
                return send(res, 404, { error: "API route not found" });
            }
            serveStatic(url.pathname, res);
        } catch (error) {
            console.error("Request failed:", error);
            if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            if (!res.destroyed) res.end(JSON.stringify({ error: "Internal server error" }));
        }
    });

    server.listen(config.port, config.host, () => {
        console.log(`Sensor app listening on ${config.host}:${config.port}`);
    });

    const shutdown = async () => {
        engine.stop();
        server.close();
        await storage.closeStorage();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main().catch((error) => {
    console.error("Backend startup failed:", error.message);
    process.exitCode = 1;
});