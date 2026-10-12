const storage = require("./storage");
const { PumpModel, validateControl } = require("./pumpmodel");

const HEARTBEAT_STALE_MS = 3500;
const DEFAULT_CONTROL = { mode: "dp", constDp: 1.0, constFlow: 1500 };

class DeviceWorker {
    constructor({ name, stream, getControl, tickMs = 1000 }) {
        this.name = name;
        this.stream = stream;
        this.getControl = getControl;      // shared manual setpoints (same for both devices)
        this.tickMs = tickMs;
        this.timer = null;
        this.running = false;
        this.wasActive = false;
        this.nextAt = 0;
        this.model = new PumpModel();
    }

    start(delay = 0) {
        if (this.running) return;
        this.running = true;
        this.nextAt = Date.now() + delay;
        this.schedule(delay);
    }

    stop() {
        this.running = false;
        clearTimeout(this.timer);
    }

    schedule(delay) {
        if (!this.running) return;
        this.timer = setTimeout(() => this.tick(), Math.max(0, delay));
    }

    async shouldBeActive() { return false; }   // overridden

    async tick() {
        const scheduledAt = this.nextAt;
        try {
            const active = await this.shouldBeActive();
            if (active) {
                if (!this.wasActive) await this.loadContinuity(); // take over from last RPM / dP / P2
                await this.produce();
            }
            this.wasActive = active;
        } catch (err) {
            console.error(`[${this.name}] tick failed:`, err.message);
        }
        // fixed 1s cadence; if we fell behind, don't burst to catch up
        this.nextAt = Math.max(scheduledAt + this.tickMs, Date.now());
        this.schedule(this.nextAt - Date.now());
    }

    async loadContinuity() {
        this.model.restore(await storage.getLatestReading());
    }

    async produce() {
        const values = this.model.step(this.getControl());
        const saved = await storage.saveReading({
            timestamp: new Date().toISOString(),
            activeDevice: this.name,
            ...values
        });
        this.stream.publish(saved);
        return saved;
    }
}

/* ---------- Device 1 (Master) ---------- */
class Device1Worker extends DeviceWorker {
    constructor(stream, getControl) {
        super({ name: "Device 1 (Master Active)", stream, getControl });
        this.interrupted = false;
        this.stateChain = Promise.resolve();   // keeps feed_state writes in order
    }

    async shouldBeActive() { return !this.interrupted; }

    queueState(fn) {
        const run = this.stateChain.then(fn);
        this.stateChain = run.catch(e => console.error("feed_state write failed:", e.message));
        return run;
    }

    async produce() {
        const saved = await super.produce();
        // heartbeat is not awaited; the interrupted check runs when the write executes
        const snapshot = { RPM: saved.RPM, dP: saved.dP };
        this.queueState(async () => {
            if (!this.interrupted) await storage.setFeedState(true, snapshot);
        }).catch(() => {});
        return saved;
    }

    async setInterrupted(flag) {
        this.interrupted = flag;
        if (flag) this.wasActive = false;                // reload values on resume
        await this.queueState(() => storage.setFeedState(!flag, {}));
    }
}

/* ---------- Device 2 (Failover) ---------- */
class Device2Worker extends DeviceWorker {
    constructor(stream, getControl) {
        super({ name: "Device 2 (Failover Active)", stream, getControl });
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
        this.control = { ...DEFAULT_CONTROL };      // manual const dP / const flow
        const getControl = () => this.control;
        this.d1 = new Device1Worker(stream, getControl);
        this.d2 = new Device2Worker(stream, getControl);
    }

    /* load the last manual setpoints saved in Neon (survives restarts) */
    async init() {
        try {
            const saved = await storage.getSetpoint();
            if (saved) {
                const v = validateControl(saved, this.control);
                if (v.ok) this.control = v.value;
            }
        } catch (e) {
            console.error("Could not load saved setpoint:", e.message);
        }
    }

    start() {
        this.d1.start(0);
        this.d2.start(700);   // offset so D1's first heartbeat lands before D2 checks
    }

    stop() { this.d1.stop(); this.d2.stop(); }

    getControl() { return { ...this.control }; }

    async setControl(input) {
        const v = validateControl(input || {}, this.control);
        if (!v.ok) return v;
        this.control = v.value;                       // takes effect on the very next second
        await storage.setSetpoint(this.control);      // persisted: both devices + restarts use it
        return { ok: true, value: this.getControl() };
    }

    async setDevice1State(active) {
        await this.d1.setInterrupted(!active);
        return this.getStatus();
    }

    async getStatus() {
        const device1Active = !this.d1.interrupted;
        const latest = await storage.getLatestReading();
        return {
            device1Active,
            activeWorker: device1Active ? "Device 1 (Master Active)" : "Device 2 (Failover Active)",
            count: latest ? latest.id : 0,
            latest,
            control: this.getControl()
        };
    }
}

module.exports = { FailoverEngine };