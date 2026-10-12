/* Pump model fitted to rittal_report_20260817_115012.xlsx
   - dP[bar]      = K_DP * RPM^2 (pump affinity law, fitted: K_DP ~ 3.5e-7, r = 0.997)
   - P1           = P2 + dP
   - P2           ~ 1.127 - 5.5e-5 * RPM   (suction side rises a little at low speed)
   - RPM range    : 905 (minimum operating speed) .. 2395 (max)
   - RPM ramps up, then HOLDS once the process value reaches the setpoint (no overshoot)
   Two control modes, both entered manually:
     "dp"   -> hold a constant differential pressure (bar)
     "flow" -> hold a constant flow (L/min)  [flow assumed proportional to RPM] */

const K_DP = 3.5e-7;
const RPM_MIN = 905;
const RPM_MAX = 2395;

/* !!! CALIBRATE: your report has no flow column, so this is an assumption.
   Flow is taken as proportional to RPM, with FLOW_AT_MAX_RPM at 2395 RPM. */
const FLOW_AT_MAX_RPM = 3000;                 // L/min
const FLOW_PER_RPM = FLOW_AT_MAX_RPM / RPM_MAX;

const DP_RANGE = 2.0;                         // bar (full scale)
const FLOW_RANGE = FLOW_AT_MAX_RPM;           // L/min (full scale)

/* controller / plant tuning, matched to the settling times in the report */
const KN = 55;          // RPM/s per unit of full-scale error
const SLEW_UP = 25;     // max RPM rise per second
const SLEW_DOWN = 30;   // max RPM fall per second
const TAU_DP = 6;       // s, dP lag behind RPM
const TAU_P2 = 8;       // s, P2 lag

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function gauss() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const p2Target = rpm => 1.127 - 5.5e-5 * rpm;

const LIMITS = { dpMin: 0, dpMax: 2.0, flowMin: 0, flowMax: FLOW_AT_MAX_RPM };

class PumpModel {
    constructor() {
        this.rpm = RPM_MIN;
        this.dp = K_DP * this.rpm * this.rpm;
        this.p2 = p2Target(this.rpm);
    }

    /* continue from the last stored reading (used on failover / resume) */
    restore(row) {
        if (!row) return;
        const rpm = Number(row.RPM), dp = Number(row.dP), p2 = Number(row.P2);
        if (Number.isFinite(rpm)) this.rpm = clamp(rpm, RPM_MIN, RPM_MAX);
        this.dp = Number.isFinite(dp) ? dp : K_DP * this.rpm * this.rpm;
        this.p2 = Number.isFinite(p2) ? p2 : p2Target(this.rpm);
    }

    /* advance one second under control = { mode, constDp, constFlow } */
    step(control, dt = 1) {
        const flowMode = control.mode === "flow";
        const sp = flowMode ? Number(control.constFlow) : Number(control.constDp);
        const pv = flowMode ? FLOW_PER_RPM * this.rpm : this.dp;
        const range = flowMode ? FLOW_RANGE : DP_RANGE;

        // RPM rises while the process value is below the setpoint, stops (holds) at the setpoint
        const cmd = clamp(KN * (sp - pv) / range, -SLEW_DOWN, SLEW_UP);
        this.rpm = clamp(this.rpm + cmd * dt, RPM_MIN, RPM_MAX);

        this.dp += (K_DP * this.rpm * this.rpm - this.dp) * (1 - Math.exp(-dt / TAU_DP));
        this.p2 += (p2Target(this.rpm) - this.p2) * (1 - Math.exp(-dt / TAU_P2));

        // setpoint dP shown in TCS_dP_P1_P2 / dP_SetpointDiff
        const dpSetpoint = flowMode
            ? K_DP * Math.pow(sp / FLOW_PER_RPM, 2)
            : sp;

        // measured values carry a little sensor noise (as in the report's steady state)
        const rpmOut = Math.round(clamp(this.rpm + gauss() * 2.5, RPM_MIN - 5, RPM_MAX));
        const dpOut = Math.max(0, this.dp + gauss() * 0.004);
        const p2Out = this.p2 + gauss() * 0.002;
        const p1Out = p2Out + dpOut;
        const r3 = v => Math.round(v * 1000) / 1000;

        return {
            P1: r3(p1Out),
            P2: r3(p2Out),
            dP: r3(dpOut),
            RPM: rpmOut,
            dP_SetpointDiff: r3(dpOut - dpSetpoint),
            TCS_dP_P1_P2: r3(dpSetpoint),
            ConstDP: Number(control.constDp),
            ConstFlow: Number(control.constFlow),
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