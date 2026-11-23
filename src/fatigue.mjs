// Per-rider fatigue estimate from live power.
//
// "Battery" = W' balance (Skiba differential model): W' is the energy you
// can spend above critical power (we use the rider's Zwift FTP as CP) before you blow up. Riding
// above FTP drains it, riding below refills it. 100% = fully recovered, 0% = nothing left to attack with.
// It's a model: FTP in Zwift profiles can be stale or sandbagged, and we only see riders while
// they're near you, so a rider we just met starts at 100% (shown faded until we've watched 2 min).

export const W_PRIME_DEFAULT = 20000;   // J, typical for trained amateurs
const WINDOW_MS = 5 * 60 * 1000;
const MAX_GAP_S = 10;                   // don't integrate across gaps where we lost sight of them
const PULL_DRAFT_W = 10;                // draft below this while moving fast = in the wind
const PULL_MIN_KMH = 25;


export class Fatigue {
    constructor() {
        this.cp = null;
        this.wPrime = W_PRIME_DEFAULT;
        this.wbal = null;
        this.lastWT = null;
        this.observed = 0;      // seconds of continuous-ish observation
        this.samples = [];      // [{wt, p, d, v, dt}]
    }

    configure(cp) {
        if (cp && cp !== this.cp) {
            this.cp = cp;
            this.wbal = this.wPrime;
            this.observed = 0;
        }
    }

    add(state) {
        const wt = state.worldTime;
        const p = state.power || 0;
        let dt = 0;
        if (this.lastWT != null) {
            dt = (wt - this.lastWT) / 1000;
            if (dt <= 0) {
                return;
            }
            if (dt > MAX_GAP_S) {
                dt = 0;  // lost sight of them; don't guess what they did meanwhile
            } else {
                this.observed += dt;
                if (this.cp) {
                    const cpDelta = (this.cp - p) * dt;
                    this.wbal += cpDelta > 0 ? cpDelta * (this.wPrime - this.wbal) / this.wPrime : cpDelta;
                    if (this.wbal > this.wPrime) {
                        this.wbal = this.wPrime;
                    }
                }
            }
        }
        this.lastWT = wt;
        const s = this.samples;
        s.push({wt, p, d: state.draft || 0, v: state.speed || 0, hr: state.heartrate || 0, dt});
        const cutoff = wt - WINDOW_MS;
        let drop = 0;
        while (drop < s.length && s[drop].wt < cutoff) {
            drop++;
        }
        if (drop) {
            s.splice(0, drop);
        }
    }

    _avg(windowMs, fn) {
        const s = this.samples;
        if (!s.length) {
            return null;
        }
        const cutoff = s.at(-1).wt - windowMs;
        let sum = 0;
        let time = 0;
        for (let i = s.length - 1; i >= 0 && s[i].wt >= cutoff; i--) {
            if (s[i].dt) {
                sum += fn(s[i]) * s[i].dt;
                time += s[i].dt;
            }
        }
        return time >= Math.min(20, windowMs / 1000 / 3) ? sum / time : null;
    }

    // Time-weighted average of fn over samples between `fromMs` and `toMs` ago (only where ok(x)).
    _avgRange(fromMs, toMs, fn, ok = () => true) {
        const s = this.samples;
        if (!s.length) {
            return null;
        }
        const end = s.at(-1).wt;
        let sum = 0;
        let time = 0;
        for (let i = s.length - 1; i >= 0; i--) {
            const age = end - s[i].wt;
            if (age > fromMs) {
                break;
            }
            if (age >= toMs && s[i].dt && ok(s[i])) {
                sum += fn(s[i]) * s[i].dt;
                time += s[i].dt;
            }
        }
        return time >= 20 ? sum / time : null;
    }

    // Heart-rate drift: HR rising over the last minute while power stays flat or drops is a classic
    // sign of a rider cracking. Works without knowing their max HR (it's the trend, not the number).
    _hrDrift() {
        const hasHr = x => x.hr > 0;
        const hrNow = this._avgRange(60000, 0, x => x.hr, hasHr);
        const hrBefore = this._avgRange(120000, 60000, x => x.hr, hasHr);
        const pNow = this._avgRange(60000, 0, x => x.p);
        const pBefore = this._avgRange(120000, 60000, x => x.p);
        if (hrNow == null || hrBefore == null || pNow == null || !pBefore) {
            return {hrRise: null, cracking: false};
        }
        const hrRise = Math.round(hrNow - hrBefore);
        return {hrRise, cracking: hrRise >= 5 && pNow / pBefore <= 1.03};
    }

    summary(weight) {
        const battery = this.cp && this.wbal != null ?
            Math.max(0, Math.min(100, Math.round(this.wbal / this.wPrime * 100))) : null;
        const p1 = this._avg(60000, x => x.p);
        const p5 = this._avg(WINDOW_MS, x => x.p);
        const pull = this._avg(WINDOW_MS, x => (x.v >= PULL_MIN_KMH && x.d < PULL_DRAFT_W) ? 1 : 0);
        return {
            battery,
            fresh: this.observed < 120,     // < 2 min watched: battery not trustworthy yet
            wkg1: p1 != null && weight ? Math.round(p1 / weight * 10) / 10 : null,
            wkg5: p5 != null && weight ? Math.round(p5 / weight * 10) / 10 : null,
            ftpPct1: p1 != null && this.cp ? Math.round(p1 / this.cp * 100) : null,
            pull: pull != null ? Math.round(pull * 100) : null,
            cp: this.cp,
            hr: this.samples.at(-1)?.hr || null,
            ...this._hrDrift(),
        };
    }
}
