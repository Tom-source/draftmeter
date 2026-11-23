// Terrain ahead: places a rider on their Zwift route (or, without a route, on their current road)
// and returns the elevation profile of the next few km plus the next climb.
//
// Road geometry, route manifests and the spline/route helpers in src/vendor are third-party GPL v3 code
// (see src/zwift/NOTICE.md); the rider-on-route logic is adapted from the same project.
import FS from 'node:fs';
import Path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as Curves from './vendor/curves.mjs';
import * as Routes from './vendor/routes.mjs';

const __dirname = Path.dirname(fileURLToPath(import.meta.url));
const dataDir = Path.join(__dirname, 'zwift', 'data');
const EPS = Routes.routeDistEpsilon;
const STEP = 25;  // meters between profile samples

const worldMetas = new Map();     // courseId -> meta
const roadsByCourse = new Map();  // courseId -> Map(roadId -> road)
const curveCache = new Map();     // `${courseId}-${roadId}` -> RoadPath
const routeCache = new Map();     // routeId -> prepared route | null
let routesById;


function load() {
    if (routesById) {
        return;
    }
    for (const x of JSON.parse(FS.readFileSync(Path.join(dataDir, 'worldlist.json')))) {
        worldMetas.set(x.courseId, x);
    }
    routesById = new Map();
    for (const r of JSON.parse(FS.readFileSync(Path.join(dataDir, 'routes.json')))) {
        const meta = [...worldMetas.values()].find(x => x.worldId === r.worldId);
        if (meta) {
            r.courseId = meta.courseId;
            routesById.set(r.id, r);
        }
    }
}


function getRoads(courseId) {
    if (!roadsByCourse.has(courseId)) {
        const meta = worldMetas.get(courseId);
        const m = new Map();
        try {
            for (const r of JSON.parse(FS.readFileSync(Path.join(dataDir, 'worlds', String(meta.worldId), 'roads.json')))) {
                m.set(r.id, r);
            }
        } catch(e) {
            console.warn('No road data for course', courseId, e.message);
        }
        roadsByCourse.set(courseId, m);
    }
    return roadsByCourse.get(courseId);
}


function getRoadCurvePath(courseId, roadId) {
    const key = `${courseId}-${roadId}`;
    if (!curveCache.has(key)) {
        const road = getRoads(courseId).get(roadId);
        let rcp = null;
        if (road) {
            const fn = road.splineType === 'Bezier' ? Curves.cubicBezierPath : Curves.catmullRomPath;
            rcp = fn(road.path, {loop: road.looped, road: true});
            rcp.physicsSlopeScale = road.physicsSlopeScaleOverride;
            rcp.looped = !!road.looped;
        }
        curveCache.set(key, rcp);
    }
    return curveCache.get(key);
}


function zToAltitude(worldMeta, z, scale) {
    const s = scale || worldMeta?.physicsSlopeScale || 1;
    return (z - (worldMeta?.seaLevel || 0) + (worldMeta?.eleOffset || 0)) / 100 * s;
}


// Sample a curve path into [distance (m), elevation (m)] pairs, in the path's own direction.
function profileOf(worldMeta, curvePath, scale) {
    const dist = [];
    const elev = [];
    let d = 0;
    let prev;
    let prevIndex;
    curvePath.trace(x => {
        d += prev ? Curves.vecDist(prev, x.stepNode) / 100 : 0;
        if (x.index !== prevIndex) {
            dist.push(d);
            elev.push(zToAltitude(worldMeta, x.stepNode[2], scale));
            prevIndex = x.index;
        }
        prev = x.stepNode;
    }, EPS);
    if (prev && dist.at(-1) !== d) {
        dist.push(d);
        elev.push(zToAltitude(worldMeta, prev[2], scale));
    }
    return {dist, elev};
}


function getRoute(routeId) {
    load();
    if (routeCache.has(routeId)) {
        return routeCache.get(routeId);
    }
    let prepared = null;
    const route = routesById.get(routeId);
    if (route) {
        try {
            const roadCurvePaths = new Map();
            for (const m of route.manifest) {
                if (!roadCurvePaths.has(m.roadId)) {
                    const rcp = getRoadCurvePath(route.courseId, m.roadId);
                    if (!rcp) {
                        throw new Error(`missing road ${m.roadId}`);
                    }
                    roadCurvePaths.set(m.roadId, rcp);
                }
            }
            const meta = Routes.getRouteMeta(route, {roadCurvePaths});
            const wm = worldMetas.get(route.courseId);
            for (const s of meta.sections) {
                const scale = s.roadId != null ? roadCurvePaths.get(s.roadId)?.physicsSlopeScale : undefined;
                s.profile = profileOf(wm, s.reverse ? s.roadCurvePath.toReversed() : s.roadCurvePath, scale);
            }
            const firstLap = meta.sections.findIndex(x => !x.leadin && !x.weld);
            prepared = {route, meta, firstLap, loops: !!route.supportedLaps};
        } catch(e) {
            console.warn('Route prep failed:', routeId, e.message);
        }
    }
    routeCache.set(routeId, prepared);
    return prepared;
}


// Meters into `section` (travel direction) for this state, or null.  Adapted from the upstream
// _getRoadSectionDistanceOffset, tolerating up to 200 m outside the section.
function sectionOffset(section, state) {
    if (section.roadId !== state.roadId || !section.reverse !== !state.reverse || !section.roadCurvePath) {
        return null;
    }
    const p = (state.roadTime - 5000) / 1e6;
    if (p - section.start > -2e-3 && section.end - p > -2e-3) {
        const d = section.roadCurvePath.distanceAtRoadPercent(p) / 100;
        return section.reverse ? section.distance - d : d;
    }
    const roadPath = getRoadCurvePath(state.courseId, state.roadId);
    const predicate = 200 * 100 + 1;
    if (p < section.start) {
        const gap = roadPath.distanceBetweenRoadPercents(p, section.start, EPS, {predicate}) / 100;
        if (gap < 200) {
            return section.reverse ? section.distance + gap : -gap;
        }
    } else {
        const gap = roadPath.distanceBetweenRoadPercents(section.end, p, EPS, {predicate}) / 100;
        if (gap < 200) {
            return section.reverse ? -gap : section.distance + gap;
        }
    }
    return null;
}


function locateOnRoute(prep, state, hint) {
    const {meta} = prep;
    const secs = meta.sections;
    const tryIdx = i => {
        const s = secs[i];
        const d = s && !s.weld ? sectionOffset(s, state) : null;
        return d == null ? null : {index: i, d};
    };
    // 1. Route checkpoint index (most reliable), allowing it to lag a few sections.
    if (state.routeCheckpointIndex) {
        const s = meta.checkpointSectionMap.get(state.routeCheckpointIndex);
        if (s) {
            const start = secs.indexOf(s);
            for (let i = start; i < start + 7 && i < secs.length; i++) {
                const hit = tryIdx(i);
                if (hit) {
                    return hit;
                }
            }
        }
    }
    // 2. Near where we found them last time.
    if (hint != null) {
        for (let k = 0; k < secs.length; k++) {
            const hit = tryIdx((hint + k) % secs.length);
            if (hit) {
                return hit;
            }
        }
    }
    // 3. Lead-in sections early in the ride, otherwise any lap/weld section.
    for (let i = 0; i < secs.length; i++) {
        if (secs[i].leadin && state.laps) {
            continue;
        }
        const s = secs[i];
        const d = sectionOffset(s, state);
        if (d != null) {
            return {index: i, d};
        }
    }
    return null;
}


// Walk the profile forward from (section index, d) for `ahead` meters.
function routeAhead(prep, loc, ahead) {
    const secs = prep.meta.sections;
    const out = [];
    let base = -loc.d;  // distance from rider to start of current section
    let i = loc.index;
    let guard = 0;
    while (guard++ < 400) {
        const s = secs[i];
        const {dist, elev} = s.profile;
        for (let k = 0; k < dist.length; k++) {
            const x = base + dist[k];
            if (x >= -STEP && x <= ahead) {
                out.push([x, elev[k]]);
            }
        }
        base += s.distance + (s.marginEndDistance || 0);
        if (base > ahead) {
            break;
        }
        // Next section in travel order: lead-in -> lap -> weld -> lap ...
        let next = i + 1;
        if (next >= secs.length) {
            if (!prep.loops || prep.firstLap < 0) {
                break;  // A-to-B route: finish
            }
            next = prep.firstLap;
        }
        i = next;
    }
    return out;
}


// No route: follow the current road in the direction of travel.
function roadAhead(state, ahead) {
    const rcp = getRoadCurvePath(state.courseId, state.roadId);
    if (!rcp) {
        return null;
    }
    const wm = worldMetas.get(state.courseId);
    const p = Math.min(1, Math.max(0, (state.roadTime - 5000) / 1e6));
    const pieces = [];
    if (!state.reverse) {
        pieces.push(rcp.subpathAtRoadPercents(p, 1, {epsilon: EPS}));
        if (rcp.looped) {
            pieces.push(rcp.subpathAtRoadPercents(0, p, {epsilon: EPS}));
        }
    } else {
        pieces.push(rcp.subpathAtRoadPercents(0, p, {epsilon: EPS}).toReversed());
        if (rcp.looped) {
            pieces.push(rcp.subpathAtRoadPercents(p, 1, {epsilon: EPS}).toReversed());
        }
    }
    const out = [];
    let base = 0;
    for (const piece of pieces) {
        const {dist, elev} = profileOf(wm, piece, rcp.physicsSlopeScale);
        for (let k = 0; k < dist.length && base + dist[k] <= ahead; k++) {
            out.push([base + dist[k], elev[k]]);
        }
        base += dist.at(-1) || 0;
        if (base > ahead) {
            break;
        }
    }
    return out;
}


// Resample to an even grid so grades are comparable.
function resample(points, ahead) {
    if (!points || points.length < 2) {
        return null;
    }
    points.sort((a, b) => a[0] - b[0]);
    const out = [];
    let j = 0;
    for (let x = 0; x <= Math.min(ahead, points.at(-1)[0]); x += STEP) {
        while (j < points.length - 2 && points[j + 1][0] < x) {
            j++;
        }
        const [x0, y0] = points[j];
        const [x1, y1] = points[j + 1];
        const t = x1 > x0 ? Math.min(1, Math.max(0, (x - x0) / (x1 - x0))) : 0;
        out.push(y0 + (y1 - y0) * t);
    }
    return out;
}


// Find climbs: stretches averaging >= 2.5% over >= 300 m and >= 12 m gain, tolerating short dips.
export function findClimbs(elev, step = STEP) {
    const n = elev.length;
    if (n < 3) {
        return [];
    }
    const win = Math.max(1, Math.round(100 / step));  // 100 m smoothing window for grade
    const grade = [];
    for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - (win >> 1));
        const b = Math.min(n - 1, a + win);
        grade.push((elev[b] - elev[a]) / ((b - a) * step || 1));
    }
    const climbs = [];
    let start = null;
    let lastUp = null;
    for (let i = 0; i < n; i++) {
        if (grade[i] >= 0.02) {
            if (start == null) {
                start = i;
            }
            lastUp = i;
        } else if (start != null && (i - lastUp) * step > 150) {
            climbs.push([start, lastUp]);
            start = null;
        }
    }
    if (start != null) {
        climbs.push([start, lastUp]);
    }
    return climbs.map(([a, b]) => {
        // Trim to the actual low and high points.
        let lo = a;
        let hi = b;
        for (let i = a; i <= b; i++) {
            if (elev[i] < elev[lo]) {
                lo = i;
            }
        }
        for (let i = lo; i <= Math.min(n - 1, b + 2); i++) {
            if (elev[i] >= elev[hi]) {
                hi = i;
            }
        }
        const length = (hi - lo) * step;
        const gain = elev[hi] - elev[lo];
        return {start: lo * step, end: hi * step, length, gain, grade: length ? gain / length : 0};
    }).filter(c => c.length >= 300 && c.gain >= 12 && c.grade >= 0.025);
}


// Roads missing from the bundled map data (Zwift keeps adding roads) are learned from the stream:
// every rider reports roadId + roadTime + x/y/z, so after a few minutes we know the road's shape.
// Buckets of 1/2000th of the road; persisted to disk so coverage grows ride after ride.
const LEARN_BUCKETS = 2000;

export class LearnedRoads {
    constructor(file) {
        this.file = file;
        this.roads = new Map();   // `${courseId}-${roadId}` -> {x, y, z, n: Float64Array/Uint16Array}
        this._dirty = false;
        if (file) {
            try {
                for (const [k, v] of Object.entries(JSON.parse(FS.readFileSync(file, 'utf8')))) {
                    const r = this._new();
                    for (const [i, x, y, z, n] of v) {
                        r.x[i] = x; r.y[i] = y; r.z[i] = z; r.n[i] = n;
                    }
                    this.roads.set(k, r);
                }
            } catch {
                // first run
            }
        }
    }

    _new() {
        return {x: new Float64Array(LEARN_BUCKETS + 1), y: new Float64Array(LEARN_BUCKETS + 1),
                z: new Float64Array(LEARN_BUCKETS + 1), n: new Uint16Array(LEARN_BUCKETS + 1)};
    }

    static isKnown(courseId, roadId) {
        load();
        return worldMetas.has(courseId) && getRoads(courseId).has(roadId);
    }

    observe(state) {
        if (state.roadTime == null || !state.courseId || state.portal || state.x == null) {
            return;
        }
        const key = `${state.courseId}-${state.roadId}`;
        let r = this.roads.get(key);
        if (!r) {
            if (LearnedRoads.isKnown(state.courseId, state.roadId)) {
                return;
            }
            r = this._new();
            this.roads.set(key, r);
        }
        const p = (state.roadTime - 5000) / 1e6;
        if (p < 0 || p > 1) {
            return;
        }
        const i = Math.round(p * LEARN_BUCKETS);
        const n = r.n[i];
        if (n >= 50) {
            return;  // plenty
        }
        r.x[i] = (r.x[i] * n + state.x) / (n + 1);
        r.y[i] = (r.y[i] * n + state.y) / (n + 1);
        r.z[i] = (r.z[i] * n + state.z) / (n + 1);
        r.n[i] = n + 1;
        this._dirty = true;
    }

    save() {
        if (!this.file || !this._dirty) {
            return;
        }
        const out = {};
        for (const [k, r] of this.roads) {
            const rows = [];
            for (let i = 0; i <= LEARN_BUCKETS; i++) {
                if (r.n[i]) {
                    rows.push([i, Math.round(r.x[i]), Math.round(r.y[i]), Math.round(r.z[i]), r.n[i]]);
                }
            }
            out[k] = rows;
        }
        FS.mkdirSync(Path.dirname(this.file), {recursive: true});
        FS.writeFileSync(this.file, JSON.stringify(out));
        this._dirty = false;
    }

    // Points [meters ahead, altitude] along the learned road in the direction of travel.
    ahead(state, ahead) {
        const r = this.roads.get(`${state.courseId}-${state.roadId}`);
        if (!r) {
            return null;
        }
        const wm = worldMetas.get(state.courseId);
        const p = (state.roadTime - 5000) / 1e6;
        let i = Math.round(p * LEARN_BUCKETS);
        const dir = state.reverse ? -1 : 1;
        const out = [[0, zToAltitude(wm, state.z ?? r.z[i])]];
        let d = 0;
        let px = state.x ?? r.x[i];
        let py = state.y ?? r.y[i];
        let pz = state.z ?? r.z[i];
        let missing = 0;
        for (i += dir; i >= 0 && i <= LEARN_BUCKETS && d <= ahead; i += dir) {
            if (!r.n[i]) {
                if (++missing > 40) {
                    break;  // haven't seen anyone ride this stretch yet
                }
                continue;
            }
            missing = 0;
            d += Math.hypot(r.x[i] - px, r.y[i] - py, r.z[i] - pz) / 100;
            px = r.x[i];
            py = r.y[i];
            pz = r.z[i];
            out.push([d, zToAltitude(wm, r.z[i])]);
        }
        return out.length > 4 ? out : null;
    }
}


export class TerrainTracker {
    constructor({ahead = 5000, learned = null} = {}) {
        this.ahead = ahead;
        this.learned = learned;
        this._hint = null;
        this._last = null;
        this._lastKey = null;
    }

    // Returns {source, profile: [elev every 25 m], step, climbs, current} or null.
    update(state) {
        load();
        if (!state || state.roadTime == null || !worldMetas.has(state.courseId) || state.portal) {
            return null;
        }
        // Recompute at most every ~25 m of travel.
        const key = `${state.routeId}-${state.roadId}-${state.reverse}-${Math.round(state.roadTime / 2500)}`;
        if (key === this._lastKey && this._last) {
            return this._last;
        }
        this._lastKey = key;
        let points = null;
        let source = 'road';
        const prep = state.routeId ? getRoute(state.routeId) : null;
        if (prep) {
            const loc = locateOnRoute(prep, state, this._hint);
            if (loc) {
                this._hint = loc.index;
                points = routeAhead(prep, loc, this.ahead);
                source = 'route';
            }
        }
        if (!points || points.length < 2) {
            points = roadAhead(state, this.ahead);
            source = 'road';
        }
        if ((!points || points.length < 2) && this.learned) {
            points = this.learned.ahead(state, this.ahead);
            source = 'learned';
        }
        const profile = resample(points, this.ahead);
        if (!profile) {
            return (this._last = null);
        }
        const climbs = findClimbs(profile);
        // "current": you're on a climb if one starts at (or just behind) your position.
        const onClimb = climbs.find(c => c.start <= STEP && c.end > 0);
        const next = climbs.find(c => c.start > STEP);
        this._last = {
            source,
            routeName: prep?.route?.name || null,
            step: STEP,
            profile: profile.map(x => Math.round(x * 10) / 10),
            current: onClimb ? {
                toTop: onClimb.end,
                gain: Math.round(profile[Math.round(onClimb.end / STEP)] - profile[0]),
                grade: onClimb.end ? (profile[Math.round(onClimb.end / STEP)] - profile[0]) / onClimb.end : 0,
            } : null,
            next: next ? {in: next.start, length: next.length, gain: Math.round(next.gain), grade: next.grade} : null,
            climbs,
            here: profile[0],
        };
        return this._last;
    }
}

// Exposed for validation scripts.
export const _internal = {getRoute, locateOnRoute, routeAhead, roadAhead, zToAltitude, worldMetas, load};
