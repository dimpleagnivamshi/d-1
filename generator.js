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
class FeedGenerator {
    constructor(storage, stream, tickMs = 1000) {
        this.storage = storage; this.stream = stream; this.tickMs = tickMs;
        this.timer = null; this.running = false; this.values = initialValues(); this.lastTickAt = 0;
        
        // Master interrupt flag
        this.interrupted = false; 
    }

    // Method to toggle the interrupt state
    toggleInterrupt(isInterrupted) {
        this.interrupted = isInterrupted;
        return { success: true, interrupted: this.interrupted };
    }

    async initialize() {
        const state = await this.storage.getFeedState();
        this.values = { ...initialValues(), ...(state.last_values || {}) };
        const latest = await this.storage.getLatestReading();
        if (latest) for (const key of Object.keys(DEFAULTS)) {
            if (Number.isFinite(Number(latest[key]))) this.values[key] = Number(latest[key]);
        }
        if (state.running) await this.start();
    }

    async status() {
        const [state, count, latest] = await Promise.all([this.storage.getFeedState(), this.storage.getReadingCount(), this.storage.getLatestReading()]);
        return { running: state.running, count, latestId: latest ? latest.id : 0, latestTimestamp: latest ? latest.timestamp : null };
    }

    async start() {
        if (this.running) return this.status();
        this.running = true;
        await this.storage.setFeedState(true, this.values);
        this.lastTickAt = Date.now();
        this.schedule(this.tickMs);
        return this.status();
    }

    async stop() {
        this.running = false;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        await this.storage.setFeedState(false, this.values);
        return this.status();
    }

    schedule(delay) {
        if (this.running) this.timer = setTimeout(() => this.tick(), delay);
    }

    async tick() {
        if (!this.running) return;
        const now = Date.now();
        const row = { timestamp: new Date(now).toISOString() };
        
        for (const [key, cfg] of Object.entries(DEFAULTS)) {
            this.values[key] = nextValue(this.values[key], cfg);
            // Output 0 if interrupted to create the flatline, otherwise normal data
            row[key] = this.interrupted ? 0 : this.values[key]; 
        }
        
        try {
            const saved = await this.storage.saveReading(row);
            await this.storage.setFeedState(this.running, this.values);
            this.stream.publish(saved);
        } catch (error) {
            console.error("Sensor reading could not be persisted", error);
        }
        this.lastTickAt = now;
        if (this.running) this.schedule(Math.max(0, this.lastTickAt + this.tickMs - Date.now()));
    }
}
module.exports = { FeedGenerator, initialValues };


