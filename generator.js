const DEFAULTS = {
    P1: { start: 2.348, min: 1.138, max: 3.034, volatility: 0.04 },
    P2: { start: 1.023, min: 0.948, max: 1.138, volatility: 0.004 },
    dP: { start: 1.325, min: 0.001, max: 2.012, volatility: 0.04 },
    RPM: { start: 1883.676, min: 542, max: 2395, volatility: 35 },
    dP_SetpointDiff: { start: -0.039, min: -1.710, max: 1.992, volatility: 0.06 },
    TCS_dP_P1_P2: { start: 1.363, min: 0, max: 2.0, volatility: 0.04 }
};

function initialValues() {
    return Object.fromEntries(Object.entries(DEFAULTS).map(([key, cfg]) => [key, cfg.start]));
}

function nextValue(previous, cfg) {
    const randomStep = (Math.random() - 0.5) * 2 * cfg.volatility;
    const pullToStart = (cfg.start - previous) * 0.02;
    return Math.max(cfg.min, Math.min(cfg.max, previous + randomStep + pullToStart));
}

class UnifiedEngine {
    constructor(stream, tickMs = 1000) {
        this.stream = stream;
        this.tickMs = tickMs;
        this.timer = null;
        this.running = false;
        
        this.device1Active = true;
        this.values = initialValues();
        this.readingsLog = [];
        this.lastTickAt = 0;
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.lastTickAt = Date.now();
        this.schedule(this.tickMs);
    }

    stop() {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    schedule(delay) {
        if (!this.running) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.tick(), delay);
    }

    pushReading() {
        for (const [key, cfg] of Object.entries(DEFAULTS)) {
            this.values[key] = nextValue(this.values[key], cfg);
        }
        const row = {
            id: this.readingsLog.length + 1,
            timestamp: new Date().toISOString(),
            activeDevice: this.device1Active ? "Device 1 (Master Active)" : "Device 2 (Failover Active)",
            ...this.values
        };
        this.readingsLog.push(row);
        if (this.readingsLog.length > 5000) this.readingsLog.shift();
        this.stream.publish(row);
        return row;
    }

    tick() {
        if (!this.running) return;
        const now = Date.now();
        
        this.pushReading();

        this.lastTickAt = now;
        if (this.running) {
            const elapsed = Date.now() - now;
            const nextDelay = Math.max(0, this.tickMs - elapsed);
            this.schedule(nextDelay);
        }
    }

    setDevice1State(active) {
        this.device1Active = Boolean(active);
        return { device1Active: this.device1Active, activeWorker: this.device1Active ? "Device 1" : "Device 2" };
    }

    getStatus() {
        return {
            device1Active: this.device1Active,
            activeWorker: this.device1Active ? "Device 1 (Master Active)" : "Device 2 (Failover Active)",
            count: this.readingsLog.length,
            latest: this.readingsLog[this.readingsLog.length - 1] || null
        };
    }

    getReadings(limit = 100) {
        return this.readingsLog.slice(-limit);
    }
}

module.exports = { UnifiedEngine };