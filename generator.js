const storage = require("./storage");

const DEFAULTS = {
    P1: { start: 2.348, min: 1.138, max: 3.034, volatility: 0.04 },
    P2: { start: 1.023, min: 0.948, max: 1.138, volatility: 0.004 },
    dP: { start: 1.325, min: 0.001, max: 2.012, volatility: 0.04 },
    RPM: { start: 1883.676, min: 542, max: 2395, volatility: 35 },
    dP_SetpointDiff: { start: -0.039, min: -1.710, max: 1.992, volatility: 0.06 },
    TCS_dP_P1_P2: { start: 1.363, min: 0, max: 2.0, volatility: 0.04 }
};

const HEARTBEAT_STALE_MS = 3500;

function initialValues() {
    return Object.fromEntries(Object.entries(DEFAULTS).map(([k, c]) => [k, c.start]));
}

function nextValue(previous, cfg) {
    const step = (Math.random() - 0.5) * 2 * cfg.volatility;
    const pull = (cfg.start - previous) * 0.02;
    return Math.max(cfg.min, Math.min(cfg.max, previous + step + pull));
}

class DeviceWorker {
    constructor({ name, stream, tickMs = 1000 }) {
        this.name = name;
        this.stream = stream;
        this.tickMs = tickMs;
        this.timer = null;
        this.running = false;
        this.wasActive = false;
        this.values = initialValues();
    }

    start(delay = 0) {
        if (this.running) return;
        this.running = true;
        this.schedule(delay);
    }

    stop() {
        this.running = false;
        clearTimeout(this.timer);
    }

    schedule(delay) {
        if (!this.running) return;
        this.timer = setTimeout(() => this.tick(), delay);
    }

    async shouldBeActive() { return false; }   // overridden

    async tick() {
        const started = Date.now();
        try {
            const active = await this.shouldBeActive();
            if (active) {
                if (!this.wasActive) await this.loadContinuity(); // take over from last value
                await this.produce();
            }
            this.wasActive = active;
        } catch (err) {
            console.error(`[${this.name}] tick failed:`, err.message);
        }
        // next tick starts only after this one finishes (no overlap), keeps 1s cadence
        this.schedule(Math.max(0, this.tickMs - (Date.now() - started)));
    }

    async loadContinuity() {
        const latest = await storage.getLatestReading();
        this.values = initialValues();
        if (latest) {
            for (const key of Object.keys(DEFAULTS)) {
                if (Number.isFinite(Number(latest[key]))) this.values[key] = Number(latest[key]);
            }
        }
    }

    async produce() {
        for (const [key, cfg] of Object.entries(DEFAULTS)) {
            this.values[key] = nextValue(this.values[key], cfg);
        }
        const saved = await storage.saveReading({
            timestamp: new Date().toISOString(),
            activeDevice: this.name,
            ...this.values
        });
        this.stream.publish(saved);
        return saved;
    }
}

/* ---------- Device 1 (Master) ---------- */
class Device1Worker extends DeviceWorker {
    constructor(stream) {
        super({ name: "Device 1 (Master Active)", stream });
        this.interrupted = false;
    }

    async shouldBeActive() { return !this.interrupted; }

    async produce() {
        const saved = await super.produce();
        await storage.setFeedState(true, this.values);   // heartbeat
        return saved;
    }

    async setInterrupted(flag) {
        this.interrupted = flag;
        if (flag) this.wasActive = false;                // reload values on resume
        // write immediately so D2 reacts on its next tick (and D2 stops quickly when D1 resumes)
        await storage.setFeedState(!flag, this.values);
    }
}

/* ---------- Device 2 (Failover) ---------- */
class Device2Worker extends DeviceWorker {
    constructor(stream) {
        super({ name: "Device 2 (Failover Active)", stream });
    }

    async shouldBeActive() {
        const d1 = await storage.getFeedState();
        const d1Healthy = d1.running && d1.age_ms < HEARTBEAT_STALE_MS;
        return !d1Healthy;       // idle while D1 is healthy
    }
}

/* ---------- Facade used by server.js ---------- */
class FailoverEngine {
    constructor(stream) {
        this.d1 = new Device1Worker(stream);
        this.d2 = new Device2Worker(stream);
    }

    start() {
        this.d1.start(0);
        this.d2.start(700);   // offset so D1's first heartbeat lands before D2 checks
    }

    stop() { this.d1.stop(); this.d2.stop(); }

    async setDevice1State(active) {
        await this.d1.setInterrupted(!active);
        return this.getStatus();
    }

    async getStatus() {
        const device1Active = !this.d1.interrupted;
        return {
            device1Active,
            activeWorker: device1Active ? "Device 1 (Master Active)" : "Device 2 (Failover Active)",
            count: await storage.getReadingCount(),
            latest: await storage.getLatestReading()
        };
    }
}

module.exports = { FailoverEngine };