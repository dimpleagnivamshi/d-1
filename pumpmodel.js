/* Pump model fitted to rittal_report_20260817_115012.xlsx
   - dP[bar]  = K_DP * RPM^2          (fitted from the report, r = 0.997)
   - P1       = P2 + dP
   - P2       ~ 1.127 - 5.5e-5 * RPM, plus a slow bounded drift
   - RPM      : 905 (minimum operating speed) .. 2395 (max)

   "dp"   mode : hold a constant differential pressure (bar). RPM climbs until dP
                 reaches the setpoint (ramp matched to the report), then RPM and dP are
                 FIXED at one value each and stay flat (no overshoot).
                 P1, P2 and FLOW still vary.
   "flow" mode : hold a constant flow (L/min). Each flow is a FIXED operating
                 point: RPM, dP and FLOW go to one fixed value and stay flat.
                 P1 and P2 still vary slowly. */

const K_DP = 3.5e-7;
const RPM_MIN = 905;
const RPM_MAX = 2395;

/* !!! ASSUMPTION - CALIBRATE WITH YOUR REAL PUMP !!!
   The report has no flow column, so these flow -> RPM points are assumed.
   They reuse the report's four steady states (0.5 / 1 / 1.5 / 2 bar).
   Values between the points are linearly interpolated. */
const FLOW_TABLE = [      // [ flow L/min, RPM ]
    [500, 905],           // minimum operating speed
    [1000, 1190],         // ~0.50 bar
    [1500, 1685],         // ~1.00 bar
    [2000, 2070],         // ~1.50 bar
    [2500, 2390]          // ~2.00 bar
];
const FLOW_MIN = 0;
const FLOW_MAX = FLOW_TABLE[FLOW_TABLE.length - 1][0];

function flowToRpm(flow) {
    if (flow <= FLOW_TABLE[0][0]) return FLOW_TABLE[0][1];
    for (let i = 1; i < FLOW_TABLE.length; i++) {
        const [f0, r0] = FLOW_TABLE[i - 1];
        const [f1, r1] = FLOW_TABLE[i];
        if (flow <= f1) return r0 + (r1 - r0) * (flow - f0) / (f1 - f0);
    }
    return FLOW_TABLE[FLOW_TABLE.length - 1][1];
}

/* Flow (L/min) at a given RPM: inverse of FLOW_TABLE, so Flow can be plotted in BOTH modes */
function rpmToFlow(rpm) {
    if (rpm <= FLOW_TABLE[0][1]) return FLOW_TABLE[0][0] * Math.max(0, rpm) / FLOW_TABLE[0][1];
    for (let i = 1; i < FLOW_TABLE.length; i++) {
        const [f0, r0] = FLOW_TABLE[i - 1];
        const [f1, r1] = FLOW_TABLE[i];
        if (rpm <= r1) return f0 + (f1 - f0) * (rpm - r0) / (r1 - r0);
    }
    return FLOW_MAX;
}

const DP_RANGE = 2.0;                         // bar (full scale)
const RPM_RANGE = RPM_MAX - RPM_MIN;

/* controller / plant tuning, matched to the settling times in the report */
const KN = 55;          // RPM/s per unit of full-scale error
const SLEW_UP = 25;     // max RPM rise per second
const SLEW_DOWN = 30;   // max RPM fall per second
const TAU_DP = 6;       // s, dP lag behind RPM
const TAU_P2 = 8;       // s, P2 lag
const DP_FINE_ZONE = 0.02;   // bar, within this of the target dP the RPM closes in at a steady rate
const FLOW_MIN_STEP = 6;     // RPM/s, minimum speed when closing in on a flow's fixed RPM
const P2_DRIFT_MAX = 0.04;   // bar, slow wander of P2 (P1 follows because P1 = P2 + dP)

/* Flow sensor behaviour in Const dP mode - measured from to_be_shared.xlsx
   (Log Data rows 102-1178: Automatic Mode, dP setpoint 2 bar, measured dP 2.00 +/- 0.02).
   - Mean flow at 2 bar is 1755 L/min; during the start-up ramp flow follows dP as ~ dP^0.65
   - The sensor only refreshes about every 9.7 s and holds its value in between
   - Values are in steps of 1.2 L/min (sensor resolution)
   - Around the mean: a slow wander (about +/-6.7 L/min, time constant ~6 min)
     plus a fresh random jitter of about +/-4.1 L/min at every refresh */
const FLOW_AT_2BAR = 1755;     // L/min, mean flow when dP = 2 bar
const FLOW_DP_EXP = 0.65;      // flow = FLOW_AT_2BAR * (dP / 2) ^ 0.65
const FLOW_STEP = 1.2;         // L/min, sensor resolution
const FLOW_REFRESH_S = 9.7;    // s, the sensor value is refreshed this often
const FLOW_SLOW_SIGMA = 6.7;   // L/min, size of the slow wander
const FLOW_SLOW_TAU = 360;     // s, how slowly that wander changes
const FLOW_JITTER = 4.1;       // L/min, random jitter added at every refresh

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function gauss() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const p2Target = rpm => 1.127 - 5.5e-5 * rpm;

const LIMITS = { dpMin: 0, dpMax: 2.0, flowMin: FLOW_MIN, flowMax: FLOW_MAX };

class PumpModel {
    constructor() {
        this.rpm = RPM_MIN;
        this.dp = K_DP * this.rpm * this.rpm;
        this.p2 = p2Target(this.rpm);
        this.drift = 0;
        this.flowOffset = 0;      // used to fade Flow out when leaving Const dP mode
        this.flowSlow = 0;        // slow wander of the flow sensor (Const dP mode)
        this.flowReading = null;  // value the flow sensor is currently holding
        this.flowAcc = FLOW_REFRESH_S;   // seconds since the sensor last refreshed
        this.lastMode = null;
    }

    /* continue from the last stored reading (used on failover / resume) */
    restore(row) {
        if (!row) return;
        const rpm = Number(row.RPM), dp = Number(row.dP), p2 = Number(row.P2);
        if (Number.isFinite(rpm)) this.rpm = clamp(rpm, RPM_MIN, RPM_MAX);
        this.dp = Number.isFinite(dp) ? dp : K_DP * this.rpm * this.rpm;
        this.p2 = Number.isFinite(p2) ? p2 : p2Target(this.rpm);
        this.drift = 0;
        this.flowOffset = 0;
        this.flowSlow = 0;
        this.flowReading = null;
        this.flowAcc = FLOW_REFRESH_S;
        this.lastMode = null;
    }

    /* advance one second under control = { mode, constDp, constFlow } */
    step(control, dt = 1) {
        const flowMode = control.mode === "flow";
        let dpSetpoint, targetRpm, targetDp;

        if (flowMode) {
            targetRpm = clamp(flowToRpm(Number(control.constFlow)), RPM_MIN, RPM_MAX);
            dpSetpoint = K_DP * targetRpm * targetRpm;
            targetDp = dpSetpoint;
            // ramp to the fixed operating point, then hold it exactly
            const err = targetRpm - this.rpm;
            let cmd = clamp(KN * err / RPM_RANGE, -SLEW_DOWN, SLEW_UP);
            // minimum approach speed so it lands exactly on the fixed value (no endless creep)
            if (Math.abs(cmd) < FLOW_MIN_STEP) cmd = Math.sign(err) * Math.min(FLOW_MIN_STEP, Math.abs(err) / dt);
            this.rpm = clamp(this.rpm + cmd * dt, RPM_MIN, RPM_MAX);
            if (Math.abs(targetRpm - this.rpm) < 0.01) this.rpm = targetRpm;
        } else {
            dpSetpoint = Number(control.constDp);
            // the fixed operating point for this dP: RPM = sqrt(dP / K), within the pump's speed range
            // (below ~0.287 bar the pump sits at its minimum speed, as in the report's 0 bar data)
            targetRpm = clamp(Math.sqrt(Math.max(dpSetpoint, 0) / K_DP), RPM_MIN, RPM_MAX);
            targetDp = K_DP * targetRpm * targetRpm;
            if (Math.abs(targetDp - this.dp) >= DP_FINE_ZONE) {
                // far from the setpoint: RPM climbs/falls while dP is off the setpoint (matches the report)
                const cmd = clamp(KN * (dpSetpoint - this.dp) / DP_RANGE, -SLEW_DOWN, SLEW_UP);
                this.rpm = clamp(this.rpm + cmd * dt, RPM_MIN, RPM_MAX);
            } else {
                // dP has (almost) reached the setpoint: close in on the fixed RPM, then hold it exactly
                const err = targetRpm - this.rpm;
                let cmd = clamp(KN * err / RPM_RANGE, -SLEW_DOWN, SLEW_UP);
                if (Math.abs(cmd) < FLOW_MIN_STEP) cmd = Math.sign(err) * Math.min(FLOW_MIN_STEP, Math.abs(err) / dt);
                this.rpm = clamp(this.rpm + cmd * dt, RPM_MIN, RPM_MAX);
                if (Math.abs(targetRpm - this.rpm) < 0.01) this.rpm = targetRpm;
            }
        }

        this.dp += (K_DP * this.rpm * this.rpm - this.dp) * (1 - Math.exp(-dt / TAU_DP));
        if (this.rpm === targetRpm && Math.abs(this.dp - targetDp) < 0.0005) this.dp = targetDp;

        // P2 follows RPM and also wanders slowly (bounded); P1 = P2 + dP follows it
        this.drift = clamp(this.drift * 0.98 + gauss() * 0.004, -P2_DRIFT_MAX, P2_DRIFT_MAX);
        this.p2 += (p2Target(this.rpm) + this.drift - this.p2) * (1 - Math.exp(-dt / TAU_P2));

        // RPM and dP are perfectly flat once held (both modes); only P1 and P2 vary
        const rpmOut = Math.round(this.rpm);
        const dpOut = this.dp;
        const p2Out = this.p2 + gauss() * 0.002;
        const p1Out = p2Out + dpOut;
        const r3 = v => Math.round(v * 1000) / 1000;

        // Flow
        //  Const Flow mode -> perfectly stable: exactly the flow for the locked RPM.
        //  Const dP mode   -> behaves like the real flow sensor in the log: holds a value,
        //                     refreshes every ~9.7 s, steps of 1.2 L/min, slow wander + jitter.
        let flowOut;
        if (flowMode) {
            this.flowOffset *= 0.8;                       // fade out whatever Const dP mode left
            if (Math.abs(this.flowOffset) < 0.05) this.flowOffset = 0;
            flowOut = Math.max(0, rpmToFlow(this.rpm) + this.flowOffset);
        } else {
            if (this.lastMode !== "dp") this.flowAcc = FLOW_REFRESH_S;     // refresh right away on entering
            const base = FLOW_AT_2BAR * Math.pow(Math.max(this.dp, 0) / 2, FLOW_DP_EXP);
            const scale = base / FLOW_AT_2BAR;            // wander and jitter shrink with the flow
            // slow wander (exact Ornstein-Uhlenbeck step)
            const k = Math.exp(-dt / FLOW_SLOW_TAU);
            this.flowSlow = this.flowSlow * k + FLOW_SLOW_SIGMA * Math.sqrt(1 - k * k) * gauss();
            // the sensor refreshes every FLOW_REFRESH_S seconds, otherwise it keeps its last value
            this.flowAcc += dt;
            if (this.flowReading === null || this.flowAcc >= FLOW_REFRESH_S) {
                this.flowAcc = this.flowReading === null ? 0 : this.flowAcc - FLOW_REFRESH_S;
                const trueFlow = base + scale * (this.flowSlow + FLOW_JITTER * gauss());
                this.flowReading = Math.max(0, Math.round(trueFlow / FLOW_STEP) * FLOW_STEP);
            }
            flowOut = this.flowReading;
            this.flowOffset = flowOut - rpmToFlow(this.rpm);   // so a switch to Const Flow fades smoothly
        }
        this.lastMode = flowMode ? "flow" : "dp";

        return {
            P1: r3(p1Out),
            P2: r3(p2Out),
            dP: r3(dpOut),
            RPM: rpmOut,
            Flow: Math.round(flowOut * 10) / 10,
            dP_SetpointDiff: r3(r3(dpOut) - r3(dpSetpoint)),
            TCS_dP_P1_P2: r3(dpSetpoint),
            ConstDP: Number(control.constDp),
            // the Const Flow setpoint is only reported while Const Flow mode is active
            // (in Const dP mode it is left out, so an old typed value is not drawn as a flat line)
            ...(flowMode ? { ConstFlow: Number(control.constFlow) } : {}),
            ControlMode: flowMode ? "Const Flow" : "Const dP"
        };
    }
}

/* validates what the user typed; returns { ok, value } or { ok:false, error } */
function validateControl(input, current) {
    const mode = input.mode === "flow" ? "flow" : input.mode === "dp" ? "dp" : null;
    if (!mode) return { ok: false, error: 'mode must be "dp" or "flow"' };
    const next = { ...current, mode };
    if (input.constDp !== undefined) {
        const v = Number(input.constDp);
        if (!Number.isFinite(v) || v < LIMITS.dpMin || v > LIMITS.dpMax)
            return { ok: false, error: `Const dP must be between ${LIMITS.dpMin} and ${LIMITS.dpMax} bar` };
        next.constDp = v;
    }
    if (input.constFlow !== undefined) {
        const v = Number(input.constFlow);
        if (!Number.isFinite(v) || v < LIMITS.flowMin || v > LIMITS.flowMax)
            return { ok: false, error: `Const Flow must be between ${LIMITS.flowMin} and ${LIMITS.flowMax} L/min` };
        next.constFlow = v;
    }
    return { ok: true, value: next };
}

module.exports = { PumpModel, validateControl, LIMITS, RPM_MIN, RPM_MAX };