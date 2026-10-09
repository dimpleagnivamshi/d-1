const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

try { process.loadEnvFile(); } catch { /* .env optional (env vars are set on the host) */ }

const projectRoot = __dirname;
const mime = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8"
};

async function main() {
    const storage = require("./storage");
    const { FailoverEngine } = require("./generator");
    const { createStreamHub } = require("./stream");

    await storage.initializeStorage();          // creates tables in Neon

    const stream = createStreamHub();
    const engine = new FailoverEngine(stream);
    await storage.setFeedState(true, {});       // D1 starts healthy
    engine.start();

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
            const sendJson = (code, body) => {
                res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
                res.end(JSON.stringify(body));
            };

            if (url.pathname === "/healthz") return sendJson(200, { status: "ok" });

            if (url.pathname === "/api/status") return sendJson(200, await engine.getStatus());

            if (url.pathname === "/api/readings") {
                const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 5000);
                const rows = await storage.listReadings(limit);
                const latestId = rows.length ? rows[rows.length - 1].id : 0;
                return sendJson(200, { rows, count: latestId, latestId });
            }

            if (url.pathname === "/api/stream") return stream.handle(req, res, url);

            if (req.method === "POST" && url.pathname === "/api/device1/interrupt") {
                let body = "";
                for await (const chunk of req) body += chunk;
                let parsed;
                try { parsed = JSON.parse(body); } catch { return sendJson(400, { error: "Invalid JSON" }); }
                const result = await engine.setDevice1State(!parsed.interrupt);
                return sendJson(200, { success: true, interrupted: Boolean(parsed.interrupt), ...result });
            }

            serveStatic(url.pathname, res);
        } catch (error) {
            console.error("Request failed:", error);
            if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "Internal server error" }));
        }
    });

    const port = process.env.PORT || 3000;
    server.listen(port, "0.0.0.0", () => console.log(`Failover telemetry server on port ${port}`));

    process.on("SIGTERM", async () => {
        engine.stop();
        await storage.closeStorage();
        process.exit(0);
    });
}

function serveStatic(requestPath, res) {
    let decoded;
    try { decoded = decodeURIComponent(requestPath); } catch { res.writeHead(400); return res.end("Bad path"); }

    if (decoded === "/") decoded = "/dashboard.html";

    const file = path.resolve(projectRoot, "." + decoded);
    if (!file.startsWith(projectRoot) || !fs.existsSync(file)) {
        res.writeHead(404);
        return res.end("Not found");
    }

    const type = mime[path.extname(file).toLowerCase()] || "text/plain";
    fs.readFile(file, (error, content) => {
        if (error) { res.writeHead(500); return res.end("Read error"); }
        res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
        res.end(content);
    });
}

main().catch(err => { console.error("Startup failed:", err); process.exit(1); });