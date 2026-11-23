// When to attack: rules based on how drafting works in Zwift and what racers report works.
//
// Why these rules (sources in README):
// - Drafting saves ~23-27% on the flat, but only ~2-12% on a climb (Zwift Insider tests). An attack on
//   the flat (or on a shallow climb) lets the others follow cheaply in your wheel. On a steep climb they
//   pay almost full price, so that's where a gap sticks.
// - Attacks stick best on steep sections (~6-7%+), and work well just after the hardest pitch.
// - Short punchy climbs (<= ~1 km): go hard on the steep part and drive it all the way to the top.
//   Long climbs: an early move gets reeled in; attack in the final part.
// - Don't ease up at the crest: hold the effort over the top and into the first part of the descent,
//   while the chasers are still climbing. Since Zwift's Nov 2025 drafting update, packs descend 10-15%
//   faster, so easing off at the top lets the group close the gap quickly.
// - Before a climb the useful advice is positioning: move up and sit in, so you start it near the front.
//
// It's a nudge built on estimates (battery = W' model from Zwift FTP), not an order.

export const T = {
    shortClimb: 1000,      // m: climbs up to this length are "punchy"
    steep: 0.06,           // grade over the next 200 m to count as "steep"
    tooShallow: 0.04,      // average climb grade below this is too draftable to attack on
    longWindowShare: 0.4,  // long climb: attack within the last 40% ...
    longWindowMin: 400,    // ... or the last 400 m, whichever is longer
    minToTop: 120,         // m: closer than this to the top it's a sprint, not an attack
    punchyMaxToTop: 500,   // m: on a punchy climb, attack when the top is within this (~1.5 min effort)
    longWindowMax: 1500,   // m: never suggest a long-climb attack further than this from the top
    prepareWithin: 800,    // m: show "move up" before a climb starting within this
    minClimbLen: 300,      // m: ignore bumps shorter than this
    myMin: 55,             // % battery you need
    margin: 15,            // % you need above the group's average
    groupEmpty: 35,        // % group average that counts as "on empty"
    attackFtp: 1.2,        // assumed attack effort as a multiple of FTP, for the "enough to reach the top" check
    wPrime: 20000,         // J, same as fatigue.mjs
    overTopSecs: 30,       // keep "go over the top" up this long after the crest
    overTopRecent: 120,    // only if an attack was suggested within this many seconds before the crest
};


const km = m => m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 50) * 50} m`;
const pct = g => `${Math.round(g * 100)}%`;


export class Tactics {
    constructor() {
        this.climb = null;          // {startOdo, length} of the climb we're on
        this.lastAttackAt = -1e9;   // seconds (ride clock)
        this.crestAt = null;
    }

    // ctx: {me: {battery, fresh, cp}, group: {count, avgBattery}, terrain, speed (km/h),
    //       odo (m ridden), now (s)}
    update({me, group, terrain, speed, odo, now}) {
        const cur = terrain?.current || null;
        const next = terrain?.next || null;
        const p = terrain?.profile;
        const step = terrain?.step || 25;
        // Grade over the next 200 m: is it steep *here*?
        const g200 = p && p.length > 8 ? (p[Math.round(200 / step)] - p[0]) / 200 : 0;

        // Track the climb we're on so we know its total length and how far up we are.
        if (cur) {
            if (!this.climb) {
                this.climb = {startOdo: odo, length: cur.toTop};
            }
            this.climb.length = Math.max(this.climb.length, (odo - this.climb.startOdo) + cur.toTop);
        } else if (this.climb) {
            this.crestAt = now;   // just went over the top
            this.climb = null;
        }

        const inGroup = group?.count > 0 && group.avgBattery != null;
        const ready = me?.battery != null && !me.fresh;
        const margin = ready && inGroup ? me.battery - group.avgBattery : null;
        const stronger = ready && inGroup && me.battery >= T.myMin && margin >= T.margin;
        const vs = inGroup && ready ? ` · you ${me.battery}% vs group ${group.avgBattery}%` : '';

        // 1. Just crested after an attack: keep the power on.
        if (!cur && this.crestAt != null && now - this.crestAt <= T.overTopSecs &&
            this.crestAt - this.lastAttackAt <= T.overTopRecent) {
            return {kind: 'overtop', text: 'Keep the power on over the top · first part of the descent'};
        }

        // 2a. Final metres after an attack: don't sit up, go over the top.
        if (cur && cur.toTop < T.minToTop && now - this.lastAttackAt <= T.overTopRecent) {
            this.lastAttackAt = now;
            return {kind: 'overtop', text: 'Keep going: over the top and into the descent'};
        }

        // 2b. On a climb.
        if (cur && cur.toTop >= T.minToTop) {
            const length = this.climb?.length || cur.toTop;
            const punchy = length <= T.shortClimb;
            const avgToTop = cur.grade || 0;
            const steepHere = Math.max(g200, avgToTop) >= T.steep;
            const shallow = Math.max(g200, avgToTop) < T.tooShallow;
            // Enough battery to ride ~120% FTP from here to the top?
            const secsToTop = cur.toTop / Math.max(10 / 3.6, (speed || 0) / 3.6);
            const need = me?.cp ? (T.attackFtp - 1) * me.cp * secsToTop : 0;
            const have = ready ? me.battery / 100 * T.wPrime : 0;
            const enough = have >= need;
            const windowSize = punchy ? T.punchyMaxToTop :
                Math.min(T.longWindowMax, Math.max(T.longWindowMin, length * T.longWindowShare));
            const window = cur.toTop <= windowSize;
            const groupEmpty = inGroup && group.avgBattery <= T.groupEmpty && ready && me.battery >= 50;

            if (!shallow && steepHere && window && enough && (stronger || groupEmpty)) {
                this.lastAttackAt = now;
                const how = punchy ? 'full gas to the top' : 'go now, hold it over the top';
                return {kind: 'attack',
                        text: `ATTACK · ${km(cur.toTop)} to top @ ${pct(Math.max(g200, avgToTop))} · ${how}${vs}`};
            }
            if (!punchy && !window && stronger && !shallow) {
                return {kind: 'wait', text: `Long climb · wait ~${km(cur.toTop - windowSize)}, attack in the final part${vs}`};
            }
            if (!shallow && window && !enough && (stronger || groupEmpty) && me?.cp) {
                // How far from the top could you hold ~120% FTP with what's left?
                const reach = have / ((T.attackFtp - 1) * me.cp) * Math.max(10 / 3.6, (speed || 0) / 3.6);
                return {kind: 'wait', text: `Not enough left to go from here · go from ~${km(reach)} to top${vs}`};
            }
            if (stronger && shallow) {
                return {kind: 'wait', text: 'Too shallow to drop them: stay in the wheel'};
            }
            return null;
        }

        // 3. Climb coming: position, don't attack (the draft still protects them here).
        if (next && next.in <= T.prepareWithin && next.length >= T.minClimbLen && inGroup) {
            const plan = next.length <= T.shortClimb ? 'punchy: go on the steep part' : 'long: save it for the final part';
            return {kind: 'prepare',
                    text: `Climb in ${km(next.in)} (${km(next.length)} @ ${pct(next.grade)}) · move up, sit in · ${plan}`};
        }
        return null;
    }
}
