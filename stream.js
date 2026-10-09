function createStreamHub() {
    const clients = new Set();
    function send(client, row) {
        client.res.write("id: " + row.id + "\nevent: reading\ndata: " + JSON.stringify(row) + "\n\n");
        client.lastId = row.id;
    }
    function handle(req, res, url) {
        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        });
        res.write("retry: 2000\n\n");
        const client = { res, lastId: 0 };
        clients.add(client);
        
        const heartbeat = setInterval(() => { if (!res.destroyed) res.write(": heartbeat\n\n"); }, 20000);
        const cleanup = () => { clearInterval(heartbeat); clients.delete(client); };
        req.on("aborted", cleanup); res.on("close", cleanup);
    }
    function publish(row) {
        for (const client of clients) {
            send(client, row);
        }
    }
    return { handle, publish };
}
module.exports = { createStreamHub };