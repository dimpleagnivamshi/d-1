const { Pool } = require("pg");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
    keepAlive: true,
    max: 5
});

pool.on('error', (err) => {
    console.error('Unexpected database pool error:', err);
});

async function initializeStorage() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS telemetry_active_stream (
            id SERIAL PRIMARY KEY,
            timestamp TIMESTAMPTZ NOT NULL,
            payload JSONB NOT NULL
        )
    `);
    // speeds up "last 1 week / 1 month" exports (a range search on the time column)
    await pool.query(`
        CREATE INDEX IF NOT EXISTS telemetry_active_stream_ts_idx
        ON telemetry_active_stream ("timestamp")
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS feed_state (
            key VARCHAR(50) PRIMARY KEY,
            running BOOLEAN NOT NULL,
            last_values JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
        )
    `);
}

/* Device 1 heartbeat. age_ms is computed by the database clock, so clock
   differences between this server and Neon do not matter. */
async function getFeedState() {
    const res = await pool.query(`
        SELECT running, last_values,
               EXTRACT(EPOCH FROM (NOW() - updated_at)) * 1000 AS age_ms
        FROM feed_state WHERE key = 'd1_state'`);
    if (res.rows.length === 0) return { running: false, last_values: {}, age_ms: Infinity };
    const r = res.rows[0];
    return { running: r.running, last_values: r.last_values, age_ms: Number(r.age_ms) };
}

async function setFeedState(running, values) {
    await pool.query(`
        INSERT INTO feed_state (key, running, last_values, updated_at)
        VALUES ('d1_state', $1, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET running = $1, last_values = $2, updated_at = NOW()
    `, [running, JSON.stringify(values)]);
}

/* Manual setpoints: { mode: "dp" | "flow", constDp, constFlow } */
async function getSetpoint() {
    const res = await pool.query("SELECT last_values FROM feed_state WHERE key = 'setpoint'");
    return res.rows.length ? res.rows[0].last_values : null;
}

async function setSetpoint(control) {
    await pool.query(`
        INSERT INTO feed_state (key, running, last_values, updated_at)
        VALUES ('setpoint', true, $1, NOW())
        ON CONFLICT (key) DO UPDATE SET last_values = $1, updated_at = NOW()
    `, [JSON.stringify(control)]);
}

async function saveReading(reading) {
    const timestamp = reading.timestamp || new Date().toISOString();
    const res = await pool.query(
        "INSERT INTO telemetry_active_stream (timestamp, payload) VALUES ($1, $2) RETURNING id, timestamp, payload",
        [timestamp, JSON.stringify(reading)]
    );
    const row = res.rows[0];
    return { id: row.id, timestamp: row.timestamp, ...row.payload };
}

async function getLatestReading() {
    const res = await pool.query("SELECT id, timestamp, payload FROM telemetry_active_stream ORDER BY id DESC LIMIT 1");
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return { id: row.id, timestamp: row.timestamp, ...row.payload };
}

async function getReadingCount() {
    const res = await pool.query("SELECT COUNT(*) FROM telemetry_active_stream");
    return parseInt(res.rows[0].count, 10);
}

async function listReadings(options = 100) {
    let limit = 100;
    if (typeof options === 'object' && options !== null) {
        limit = options.limit || 100;
    } else if (typeof options === 'number') {
        limit = options;
    }

    const res = await pool.query(
        "SELECT id, timestamp, payload FROM telemetry_active_stream ORDER BY id DESC LIMIT $1",
        [limit]
    );
    return res.rows.reverse().map(row => ({
        id: row.id,
        timestamp: row.timestamp,
        ...(typeof row.payload === 'object' ? row.payload : JSON.parse(row.payload))
    }));
}

/* ---------- export of the recorded history for one graph ----------
   hours   : how far back (null = everything that is recorded)
   x, y    : column names of the graph ("timestamp" is allowed for x)
   overlay : optional third column (e.g. the dP setpoint line), or null
   At most EXPORT_MAX_ROWS rows are returned. If the period holds more readings,
   they are averaged into equal time slots so the file still opens in Excel. */
const EXPORT_MAX_ROWS = 200000;

const EXPORT_SOURCE_SQL = `
    WITH src AS (
        SELECT id,
               (EXTRACT(EPOCH FROM "timestamp") * 1000)::float8 AS t_ms,
               CASE WHEN $2::text = 'timestamp'
                    THEN (EXTRACT(EPOCH FROM "timestamp") * 1000)::float8
                    ELSE (payload->>$2::text)::float8 END AS xv,
               (payload->>$3::text)::float8 AS yv,
               CASE WHEN $4::text IS NULL THEN NULL::float8
                    ELSE (payload->>$4::text)::float8 END AS ov
        FROM telemetry_active_stream
        WHERE $1::float8 IS NULL OR "timestamp" >= NOW() - ($1::float8 * INTERVAL '1 hour')
    )`;

async function exportSeries({ hours, x, y, overlay }) {
    const params = [hours === undefined ? null : hours, x, y, overlay || null];

    const countRes = await pool.query(
        EXPORT_SOURCE_SQL + `
        SELECT COUNT(*)::int AS total, MIN(t_ms) AS first_ms, MAX(t_ms) AS last_ms
        FROM src WHERE yv IS NOT NULL AND xv IS NOT NULL`,
        params
    );
    const total = countRes.rows[0].total;
    if (total === 0) return { rows: [], total: 0, returned: 0, bucketSeconds: 0, firstMs: null, lastMs: null };
    const firstMs = Number(countRes.rows[0].first_ms);
    const lastMs = Number(countRes.rows[0].last_ms);

    let bucketSeconds = 0;
    let res;
    if (total <= EXPORT_MAX_ROWS) {
        res = await pool.query({
            text: EXPORT_SOURCE_SQL + `
                SELECT xv, yv, ov FROM src
                WHERE yv IS NOT NULL AND xv IS NOT NULL
                ORDER BY id`,
            values: params,
            rowMode: "array"
        });
    } else {
        bucketSeconds = Math.max(2, Math.ceil((lastMs - firstMs) / 1000 / EXPORT_MAX_ROWS));
        res = await pool.query({
            text: EXPORT_SOURCE_SQL + `,
                b AS (
                    SELECT *, FLOOR(t_ms / 1000 / $5::float8) AS bucket
                    FROM src WHERE yv IS NOT NULL AND xv IS NOT NULL
                )
                SELECT CASE WHEN $2::text = 'timestamp'
                            THEN MIN(bucket) * $5::float8 * 1000
                            ELSE AVG(xv) END AS xv,
                       AVG(yv) AS yv,
                       AVG(ov) AS ov
                FROM b GROUP BY bucket ORDER BY bucket`,
            values: params.concat([bucketSeconds]),
            rowMode: "array"
        });
    }
    return { rows: res.rows, total, returned: res.rows.length, bucketSeconds, firstMs, lastMs };
}

async function closeStorage() {
    await pool.end();
}

module.exports = {
    initializeStorage,
    getFeedState,
    setFeedState,
    getSetpoint,
    setSetpoint,
    saveReading,
    getLatestReading,
    getReadingCount,
    listReadings,
    exportSeries,
    EXPORT_MAX_ROWS,
    closeStorage
};