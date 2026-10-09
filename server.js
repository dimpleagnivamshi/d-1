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

function main() {
    const { UnifiedEngine } = require("./generator");
    const { createStreamHub } = require("./stream");

    const stream = createStreamHub();
    const engine = new UnifiedEngine(stream);
    engine.start(); // Starts the 1-second interval immediately

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
            
            if (url.pathname === "/healthz") {
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                return res.end(JSON.stringify({ status: "ok" }));
            }

            if (url.pathname === "/api/status") {
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                return res.end(JSON.stringify(engine.getStatus()));
            }

            if (url.pathname === "/api/readings") {
                const limit = Number(url.searchParams.get("limit")) || 100;
                const rows = engine.getReadings(limit);
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                return res.end(JSON.stringify({
                    rows,
                    count: engine.getStatus().count,
                    latestId: rows.length ? rows[rows.length - 1].id : 0
                }));
            }

            if (url.pathname === "/api/stream") {
                return stream.handle(req, res, url);
            }

            if (req.method === "POST" && url.pathname === "/api/device1/interrupt") {
                let body = '';
                req.on('data', chunk => { body += chunk.toString(); });
                req.on('end', () => {
                    try {
                        const parsed = JSON.parse(body);
                        const result = engine.setDevice1State(!parsed.interrupt);
                        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                        res.end(JSON.stringify({ success: true, interrupted: parsed.interrupt, ...result }));
                    } catch (err) {
                        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
                        res.end(JSON.stringify({ error: "Invalid JSON" }));
                    }
                });
                return;
            }

            serveStatic(url.pathname, res);
        } catch (error) {
            console.error("Request failed:", error);
            if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "Internal server error" }));
        }
    });

    const port = process.env.PORT || 3000;
    server.listen(port, "0.0.0.0", () => {
        console.log(`Unified telemetry server listening on port ${port}`);
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

main();