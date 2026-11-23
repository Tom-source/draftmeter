// Fake data source so the overlay can be tried without riding in Zwift (`npm run demo`).
import Events from 'node:events';
import {groupSummary} from './engine.mjs';
import {Tactics} from './tactics.mjs';

const names = ['J. Vos', 'L. Peeters', 'M. Janssens', 'S. de Vries', 'A. Maes', 'K. Claes', 'T. Smit'];


export class DemoEngine extends Events.EventEmitter {
    constructor() {
        super();
        this.t = 0;
        this.draftKj = 0;
        this.draftSecs = 0;
        this.powerSum = 0;
        this.maxDraft = 0;
        this.status = 'live';
        this.tactics = new Tactics();
    }

    async start() {
        this._tick = setInterval(() => this._step(), 250);
    }

    stop() {
        clearInterval(this._tick);
    }

    resetStats() {
        this.t = this.draftKj = this.draftSecs = this.powerSum = this.maxDraft = 0;
    }

    _terrain(t) {
        // A punchy 900 m climb at 6.5% that comes around every ~4.5 minutes.
        const step = 25, start0 = 650, len = 900, grade = 0.065, top = start0 + len;
        const off = (t * 11) % 3000;  // creep forward at ~40 km/h
        const elev = d => {
            const x = d + off;
            const climb = x > start0 && x < top ? (x - start0) * grade : x >= top ? len * grade - Math.min(len * grade, (x - top) * 0.03) : 0;
            return 20 + climb + Math.sin(x / 180) * 1.5;
        };
        const profile = Array.from({length: 201}, (_, i) => Math.round(elev(i * step) * 10) / 10);
        const start = Math.max(0, start0 - off);
        const end = top - off;
        return {
            source: 'route', routeName: 'Demo route', step, profile,
            current: start === 0 && end > 0 ? {toTop: end, gain: Math.round(end * grade), grade} : null,
            next: start > 0 ? {in: start, length: len, gain: Math.round(len * grade), grade} : null,
            climbs: end > 0 ? [[start, end, grade * 100]] : [],
        };
    }

    _step() {
        this.t += 0.25;
        const t = this.t;
        // Drift in and out of a group every ~40s
        const inGroup = (Math.sin(t / 13) + 1) / 2;
        const terrainNow = this._terrain(t);
        // Drafting barely helps on a climb (~2-12% vs ~25% on the flat), so the demo reflects that.
        const climbFactor = terrainNow.current ? 0.12 : 1;
        const draft = Math.max(0, Math.round((inGroup * 190 + Math.sin(t * 1.7) * 18 - 15) * climbFactor));
        const power = Math.round(235 + Math.sin(t / 3) * 25 - inGroup * 40 + Math.sin(t * 2.3) * 8);
        this.draftKj += draft * 0.25 / 1000;
        this.powerSum += power * 0.25;
        this.maxDraft = Math.max(this.maxDraft, draft);
        if (draft >= 10) {
            this.draftSecs += 0.25;
        }
        // A group that has been working: riders ahead have been pulling more than those behind.
        const bat = (i, sign) => Math.max(5, Math.min(100, Math.round(52 - i * 6 * sign + Math.sin(t / 7 + i) * 12)));
        const rider = (i, sign) => {
            const gap = sign * (0.4 + i * (1.1 + inGroup * -0.6) + (1 - inGroup) * 4);
            return {
                athleteId: 1000 + i * sign,
                name: names[(i * 2 + (sign > 0 ? 1 : 0)) % names.length],
                gap: Math.round(gap * 10) / 10,
                dist: Math.round(gap * 11),
                est: false,
                power: Math.round(power + Math.sin(t + i) * 30),
                draft: Math.round(draft * (0.6 + 0.1 * i)),
                speed: 39,
                battery: bat(i, sign),
                fresh: i === 3,
                wkg1: Math.round((3.2 + Math.sin(t / 4 + i) * 0.6) * 10) / 10,
            };
        };
        const ahead = [rider(3, -1), rider(2, -1), rider(1, -1)];
        const behind = [rider(1, 1), rider(2, 1)];
        const me = {battery: Math.round(80 + Math.sin(t / 11) * 6), fresh: false, wkg1: Math.round(power / 75 * 10) / 10};
        // Same calculations as the live engine, so the demo can't show numbers that don't add up.
        const group = groupSummary([...ahead, ...behind]);
        const terrain = terrainNow;
        this.emit('snapshot', {
            status: 'live',
            name: 'You (demo)',
            draft,
            power,
            heartrate: Math.round(148 + Math.sin(t / 9) * 8),
            cadence: Math.round(88 + Math.sin(t / 5) * 4),
            speed: Math.round((38.5 + inGroup * 3 + Math.sin(t / 4)) * 10) / 10,
            wkg: Math.round(power / 75 * 10) / 10,
            ride: {
                avgDraft: Math.round(this.draftKj * 1000 / t),
                draftKj: Math.round(this.draftKj),
                draftPct: Math.round(this.draftSecs / t * 100),
                avgPower: Math.round(this.powerSum / t),
                maxDraft: this.maxDraft,
                elapsed: Math.round(t),
            },
            me,
            group,
            attack: this.tactics.update({me: {...me, cp: 280}, group, terrain, speed: 30, odo: t * 9, now: t}),
            terrain,
            ahead,
            behind,
        });
    }
}
