// Draftmeter engine: logs a *monitor* Zwift account into the relay servers (read-only spectator,
// using Zwift's spectator connection), follows whoever your main account is watching (you, while
// riding), and turns raw PlayerState packets into a small snapshot for the overlay.

import Events from 'node:events';
import FS from 'node:fs';
import Zlib from 'node:zlib';
import * as Zwift from './zwift/zwift.mjs';
import {Fatigue} from './fatigue.mjs';
import {TerrainTracker, LearnedRoads} from './terrain.mjs';

const HISTORY_MS = 5 * 60 * 1000;      // how far back we keep road positions for gap math
const STALE_MS = 15 * 1000;            // drop riders we haven't heard from in this long
const MAX_NEARBY_GAP = 60;             // seconds: riders further away than this aren't "nearby"
const NEARBY_EACH_SIDE = 5;            // max riders shown ahead and behind
const IN_DRAFT_WATTS = 10;             // draft >= this counts as "in the draft"
const GROUP_GAP = 15;                  // seconds: riders within this are "your group" for battery averages


class RiderTrack {
    constructor(athleteId) {
        this.athleteId = athleteId;
        this.state = null;
        this.updated = 0;
        this.history = [];  // [{roadId, reverse, rc, wt, eg, ed}]
        this.fatigue = new Fatigue();
    }

    add(state) {
        if (this.state && state.worldTime <= this.state.worldTime) {
            return false;  // duplicate or stale
        }
        this.state = state;
        this.updated = Date.now();
        this.fatigue.add(state);
        const h = this.history;
        const last = h[h.length - 1];
        if (!last || state.worldTime - last.wt >= 200) {
            h.push({roadId: state.roadId, reverse: state.reverse, rc: state.roadCompletion,
                    wt: state.worldTime, eg: state.eventSubgroupId || 0, ed: state.eventDistance || 0});
            const cutoff = state.worldTime - HISTORY_MS;
            let drop = 0;
            while (drop < h.length && h[drop].wt < cutoff) {
                drop++;
            }
            if (drop) {
                h.splice(0, drop);
            }
        }
        return true;
    }
}


// When was `track` at road position (roadId, reverse, rc)?  Interpolated worldTime or null.
function findPassTime(track, roadId, reverse, rc) {
    const h = track.history;
    for (let i = h.length - 1; i > 0; i--) {
        const b = h[i];
        const a = h[i - 1];
        if (a.roadId !== roadId || b.roadId !== roadId || a.reverse !== reverse || b.reverse !== reverse) {
            continue;
        }
        const lo = Math.min(a.rc, b.rc);
        const hi = Math.max(a.rc, b.rc);
        if (rc < lo || rc > hi) {
            continue;
        }
        if (a.rc === b.rc) {
            return b.wt;
        }
        return a.wt + (b.wt - a.wt) * ((rc - a.rc) / (b.rc - a.rc));
    }
    return null;
}


// Same idea for events: when did `track` reach event distance `ed` (meters along the race course)?
// Event distance only grows, so this is unambiguous even across road changes and forks.
function findEventPassTime(track, eg, ed) {
    const h = track.history;
    for (let i = h.length - 1; i > 0; i--) {
        const b = h[i];
        const a = h[i - 1];
        if (a.eg !== eg || b.eg !== eg || ed < a.ed || ed > b.ed) {
            continue;
        }
        if (a.ed === b.ed) {
            return b.wt;
        }
        return a.wt + (b.wt - a.wt) * ((ed - a.ed) / (b.ed - a.ed));
    }
    return null;
}


function inSameEvent(m, t) {
    return !!(m.eventSubgroupId && m.eventSubgroupId === t.eventSubgroupId &&
              m.eventDistance > 0 && t.eventDistance > 0);
}


function distanceMeters(s1, s2) {
    const dx = s1.x - s2.x;
    const dy = s1.y - s2.y;
    const dz = (s1.z || 0) - (s2.z || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz) / 100;  // positions are in cm
}


// Positive gap = they are behind you, negative = ahead (seconds).
function computeGap(me, them) {
    const m = me.state;
    const t = them.state;
    if (inSameEvent(m, t)) {
        const eg = m.eventSubgroupId;
        if (t.eventDistance >= m.eventDistance) {
            const dist = t.eventDistance - m.eventDistance;
            const passed = findEventPassTime(them, eg, m.eventDistance);
            return passed != null ?
                {gap: -(m.worldTime - passed) / 1000, dist: -dist, est: false} :
                {gap: -estimate(dist, t), dist: -dist, est: true};
        } else {
            const dist = m.eventDistance - t.eventDistance;
            const passed = findEventPassTime(me, eg, t.eventDistance);
            return passed != null ?
                {gap: (t.worldTime - passed) / 1000, dist, est: false} :
                {gap: estimate(dist, m), dist, est: true};
        }
    }
    const dist = distanceMeters(m, t);
    // Same road, same direction: compare road completion directly.
    if (m.roadId === t.roadId && m.reverse === t.reverse) {
        if (t.roadCompletion >= m.roadCompletion) {
            const passed = findPassTime(them, m.roadId, m.reverse, m.roadCompletion);
            if (passed != null) {
                return {gap: -(m.worldTime - passed) / 1000, dist: -dist, est: false};
            }
            return {gap: -estimate(dist, m), dist: -dist, est: true};
        } else {
            const passed = findPassTime(me, t.roadId, t.reverse, t.roadCompletion);
            if (passed != null) {
                return {gap: (t.worldTime - passed) / 1000, dist, est: false};
            }
            return {gap: estimate(dist, m), dist, est: true};
        }
    }
    // Different road: did they pass where I am now (ahead), or did I pass where they are (behind)?
    const theyPassedMe = findPassTime(them, m.roadId, m.reverse, m.roadCompletion);
    if (theyPassedMe != null) {
        return {gap: -(m.worldTime - theyPassedMe) / 1000, dist: -dist, est: false};
    }
    const iPassedThem = findPassTime(me, t.roadId, t.reverse, t.roadCompletion);
    if (iPassedThem != null) {
        return {gap: (t.worldTime - iPassedThem) / 1000, dist, est: false};
    }
    return null;  // can't tell which way they're going relative to us
}


function estimate(dist, myState) {
    const mps = Math.max(myState.speed, 15) / 3.6;  // speed is km/h; floor avoids silly gaps when stopped
    return dist / mps;
}


class RideStats {
    constructor() {
        this.reset();
    }

    reset() {
        this.lastWT = null;
        this.time = 0;          // seconds moving
        this.draftJoules = 0;
        this.draftTime = 0;     // seconds with draft >= IN_DRAFT_WATTS
        this.powerJoules = 0;
        this.maxDraft = 0;
    }

    add(state) {
        if (this.lastWT != null) {
            const dt = (state.worldTime - this.lastWT) / 1000;
            if (dt > 0 && dt < 5 && state.speed > 1) {
                this.time += dt;
                this.draftJoules += (state.draft || 0) * dt;
                this.powerJoules += (state.power || 0) * dt;
                if ((state.draft || 0) >= IN_DRAFT_WATTS) {
                    this.draftTime += dt;
                }
            }
        }
        this.lastWT = state.worldTime;
        this.maxDraft = Math.max(this.maxDraft, state.draft || 0);
    }

    summary() {
        const t = this.time || 1;
        return {
            avgDraft: Math.round(this.draftJoules / t),
            draftKj: Math.round(this.draftJoules / 1000),
            draftPct: Math.round(this.draftTime / t * 100),
            avgPower: Math.round(this.powerJoules / t),
            maxDraft: this.maxDraft,
            elapsed: Math.round(this.time),
        };
    }
}


export class Engine extends Events.EventEmitter {
    constructor({monitorUsername, monitorPassword, athleteId, randomWatch, recordFile, learnedRoadsFile}) {
        super();
        this.randomWatch = randomWatch;
        this.diag = {selfUdp: 0, selfApi: 0, othersUdp: 0, packets: 0, since: Date.now()};
        this._record = recordFile ? openRecording(recordFile) : null;
        this._recordAll = !!process.env.DRAFTMETER_RECORD_ALL;
        this._recordedAt = new Map();
        this.creds = {monitorUsername, monitorPassword};
        this.selfAthleteId = Number(athleteId);
        this.watchingId = this.selfAthleteId;
        this.tracks = new Map();
        this.stats = new RideStats();
        this.profiles = new Map();     // athleteId -> {name, weight, ftp} | null (pending)
        this.learnedRoads = new LearnedRoads(learnedRoadsFile);
        this.terrain = new TerrainTracker({ahead: 5000, learned: this.learnedRoads});
        this._profileQueue = new Set();
        this.status = 'starting';
        this.lastError = null;
    }

    static async login(username, password) {
        if (!username || !password) {
            throw new Error('Enter the monitor account email and password.');
        }
        const api = new Zwift.ZwiftAPI();
        try {
            await api.authenticate(username, password);
        } catch(e) {
            if (e.status === 400 || e.status === 401 || /credentials/i.test(e.message)) {
                throw new Error('Zwift says: wrong email or password for the monitor account.');
            }
            throw e;
        }
        return api;
    }

    async start() {
        this._setStatus('logging-in');
        this.api = await Engine.login(this.creds.monitorUsername, this.creds.monitorPassword);
        if (this.api.profile.id === this.selfAthleteId) {
            throw new Error('The monitor login must be a different Zwift account than the one you ride with.');
        }
        // Tag states that came from the slow HTTP fallback rather than the live UDP stream.
        const getPlayerState = this.api.getPlayerState.bind(this.api);
        this.api.getPlayerState = async id => {
            const s = await getPlayerState(id);
            if (s) {
                s._viaApi = true;
            }
            return s;
        };
        this.monitor = new Zwift.GameMonitor({
            zwiftMonitorAPI: this.api,
            selfAthleteId: this.randomWatch != null ? null : this.selfAthleteId,
            randomWatch: this.randomWatch,
        });
        this.monitor.on('self-athlete', id => {
            if (id != null) {
                this.selfAthleteId = id;
            }
        });
        this.monitor.on('inPacket', pb => this._onPacket(pb));
        this.monitor.on('watching-athlete', id => {
            if (id != null && id !== this.watchingId) {
                console.info('Now watching athlete:', id);
                this.watchingId = id;
                this.stats.reset();
            }
        });
        this.monitor.start();
        this._setStatus('connecting');
        this._tick = setInterval(() => this._emitSnapshot(), 250);
        this._profileTimer = setInterval(() => this._loadProfiles(), 2000);
        this._gcTimer = setInterval(() => this._gc(), 10000);
        this._startedAt = Date.now();
        this._watchdogTimer = setInterval(() => this._watchdog(), 5000);
        this._learnTimer = setInterval(() => this.learnedRoads.save(), 120000);
        this._statusTimer = setInterval(() => {
            this.recordLine({type: 'status', ...this.diag, status: this.status});
            this._record?.flush?.();  // gzip: push buffered data to disk so a crash loses < 30 s
        }, 30000);
    }

    stop() {
        clearInterval(this._tick);
        clearInterval(this._profileTimer);
        clearInterval(this._gcTimer);
        clearInterval(this._watchdogTimer);
        clearInterval(this._learnTimer);
        try {
            this.learnedRoads.save();
        } catch(e) {
            console.warn('Saving learned roads failed:', e.message);
        }
        clearInterval(this._statusTimer);
        if (this.monitor) {
            this.monitor.stop();
        }
        // Resolves once the recording (incl. the gzip trailer) is fully on disk, or after 3 s.
        const rec = this._record;
        this._record = null;
        if (!rec) {
            return Promise.resolve();
        }
        return new Promise(resolve => {
            const timer = setTimeout(resolve, 3000);
            const file = rec instanceof Zlib.Gzip ? rec._draftmeterOut : rec;
            file.once('close', () => {
                clearTimeout(timer);
                resolve();
            });
            rec.end();
        });
    }

    resetStats() {
        this.stats.reset();
    }

    _setStatus(status) {
        if (status !== this.status) {
            this.status = status;
            this.emit('status', status);
        }
    }

    _onPacket(pb) {
        this.diag.packets++;
        for (const state of pb.playerStates) {
            const isSelf = state.athleteId === this.watchingId;
            if (isSelf) {
                this.diag[state._viaApi ? 'selfApi' : 'selfUdp']++;
            } else if (!state._viaApi) {
                this.diag.othersUdp++;
            }
            if (isSelf && !state._viaApi) {
                this._lastSelfUdp = Date.now();
            } else if (isSelf) {
                this._lastSelfApi = Date.now();
            }
            if (this._record && this._shouldRecord(state, isSelf)) {
                this.recordLine({
                    api: state._viaApi ? 1 : 0, w: this.watchingId, id: state.athleteId,
                    wt: state.worldTime, rd: state.roadId, rev: state.reverse ? 1 : 0, rc: state.roadCompletion,
                    x: Math.round(state.x), y: Math.round(state.y), z: Math.round(state.z),
                    d: state.draft || 0, p: state.power, v: Math.round(state.speed * 10) / 10,
                    eg: state.eventSubgroupId || 0, c: state.courseId, dist: state.distance,
                    ed: Math.round(state.eventDistance || 0), rt: state.roadTime, rid: state.routeId || 0,
                    rci: state.routeCheckpointIndex || 0, lap: state.laps || 0, hr: state.heartrate || 0,
                });
            }
            this.learnedRoads.observe(state);
            let track = this.tracks.get(state.athleteId);
            if (!track) {
                track = new RiderTrack(state.athleteId);
                this.tracks.set(state.athleteId, track);
            }
            if (track.add(state) && state.athleteId === this.watchingId) {
                this.stats.add(state);
            }
        }
    }

    recordLine(obj) {
        this._record?.write(JSON.stringify({t: Date.now(), ...obj}) + '\n');
    }

    // Keep recordings small: always you, plus riders close to you (same race group or < 500 m).
    _shouldRecord(state, isSelf) {
        if (isSelf || this._recordAll) {
            return true;
        }
        const me = this.tracks.get(this.watchingId)?.state;
        if (!me || state.courseId !== me.courseId) {
            return false;
        }
        const last = this._recordedAt.get(state.athleteId) || 0;
        if (state.worldTime - last < 1000) {
            return false;  // at most one line per rider per second
        }
        const near = me.eventSubgroupId && state.eventSubgroupId === me.eventSubgroupId ?
            Math.abs((state.eventDistance || 0) - (me.eventDistance || 0)) < 500 :
            distanceMeters(me, state) < 300;
        if (near) {
            this._recordedAt.set(state.athleteId, state.worldTime);
        }
        return near;
    }

    // Self-repair: if your own state stops arriving on the live UDP stream (and we're only getting
    // it from the slow 5 s HTTP fallback), rebuild the UDP channel; if that doesn't help, reconnect.
    _watchdog() {
        const m = this.monitor;
        if (!m || m.suspended || !m._session) {
            return;
        }
        const now = Date.now();
        const udpAge = now - (this._lastSelfUdp || this._startedAt);
        const apiFresh = now - (this._lastSelfApi || 0) < 12000;
        if (udpAge < 12000 || !apiFresh) {
            if (udpAge < 12000) {
                this._heals = 0;
                this._reconnects = 0;
            }
            return;
        }
        // Back off when repairs aren't helping: 20 s, then 40 s, 80 s ... up to 5 min between attempts.
        const backoff = Math.min(300000, 10000 * 2 ** (this._reconnects || 0));
        if (now - (this._lastHeal || 0) < backoff) {
            return;
        }
        this._lastHeal = now;
        this._heals = (this._heals || 0) + 1;
        // Seen on a real ride: the UDP reset never helped, a full reconnect fixed it right away.
        const action = this._heals <= 1 ? 'udp-reset' : 'reconnect';
        console.warn(`[heal] No live data for you for ${Math.round(udpAge / 1000)}s: ${action}`);
        this.recordLine({type: 'heal', action, udpAge});
        this.diag.heals = (this.diag.heals || 0) + 1;
        try {
            if (action === 'udp-reset') {
                m.setUDPChannel();
            } else {
                this._heals = 0;
                this._reconnects = (this._reconnects || 0) + 1;
                m.reconnect();
            }
        } catch(e) {
            console.error('[heal] failed:', e);
        }
    }

    _gc() {
        const now = Date.now();
        for (const [id, track] of this.tracks) {
            if (now - track.updated > 5 * 60 * 1000 && id !== this.watchingId) {
                this.tracks.delete(id);
            }
        }
    }

    _name(id) {
        const p = this.profiles.get(id);
        if (p === undefined) {
            this._profileQueue.add(id);
        }
        return p ? p.name : null;
    }

    async _loadProfiles() {
        if (!this._profileQueue.size || !this.api) {
            return;
        }
        const ids = Array.from(this._profileQueue).slice(0, 50);
        for (const id of ids) {
            this._profileQueue.delete(id);
            this.profiles.set(id, null);  // pending; don't re-queue
        }
        try {
            const profiles = await this.api.getProfiles(ids);
            for (let i = 0; i < ids.length; i++) {
                const p = profiles[i];
                if (p) {
                    const first = (p.firstName || '').trim();
                    const last = (p.lastName || '').trim();
                    this.profiles.set(ids[i], {
                        name: first ? `${first[0]}. ${last}` : last || `#${ids[i]}`,
                        weight: p.weight ? p.weight / 1000 : null,
                        ftp: p.ftp || null,
                    });
                }
            }
        } catch(e) {
            console.warn('Profile lookup failed:', e.message);
            for (const id of ids) {
                this.profiles.delete(id);  // retry later
            }
        }
    }

    // Fatigue summary for a rider; configures their CP from their Zwift FTP once the profile is in.
    _fatigue(track) {
        const prof = this.profiles.get(track.athleteId);
        if (prof?.ftp) {
            track.fatigue.configure(prof.ftp);
        }
        return track.fatigue.summary(prof?.weight);
    }

    _emitSnapshot() {
        const me = this.tracks.get(this.watchingId);
        const now = Date.now();
        if (!me || !me.state || now - me.updated > STALE_MS) {
            this._setStatus(this.monitor?.suspended ? 'waiting-for-ride' : 'connecting');
            this.emit('snapshot', {status: this.status, watchingId: this.watchingId});
            return;
        }
        this._setStatus('live');
        const s = me.state;
        const myProfile = this.profiles.get(this.watchingId) || null;
        this._name(this.watchingId);
        const ahead = [];
        const behind = [];
        for (const track of this.tracks.values()) {
            if (track === me || !track.state || now - track.updated > STALE_MS) {
                continue;
            }
            if (track.state.courseId !== s.courseId || (s.speed > 1 && !track.state.speed)) {
                continue;
            }
            // In a race/group ride, only your own event group counts (not randoms on the same road).
            if (s.eventSubgroupId && track.state.eventSubgroupId !== s.eventSubgroupId) {
                continue;
            }
            const g = computeGap(me, track);
            if (!g || Math.abs(g.gap) > MAX_NEARBY_GAP) {
                continue;
            }
            const f = this._fatigue(track);
            const row = {
                athleteId: track.athleteId,
                name: this._name(track.athleteId),
                gap: Math.round(g.gap * 10) / 10,
                dist: Math.round(g.dist),
                est: g.est,
                power: track.state.power,
                draft: track.state.draft || 0,
                speed: Math.round(track.state.speed),
                hr: track.state.heartrate || null,
                battery: f.battery,
                fresh: f.fresh,
                wkg1: f.wkg1,
                ftpPct1: f.ftpPct1,
                pull: f.pull,
            };
            (g.gap < 0 ? ahead : behind).push(row);
        }
        ahead.sort((a, b) => b.gap - a.gap);   // closest first
        behind.sort((a, b) => a.gap - b.gap);
        const myFatigue = this._fatigue(me);
        const group = groupSummary([...ahead, ...behind]);
        let terrain = null;
        try {
            terrain = this.terrain.update(s);
        } catch(e) {
            if (!this._terrainErr) {
                this._terrainErr = true;
                console.warn('Terrain unavailable:', e.message);
            }
        }
        const attack = attackHint(myFatigue, group, terrain);
        const snap = {
            status: 'live',
            watchingId: this.watchingId,
            name: myProfile?.name || null,
            draft: s.draft || 0,
            power: s.power,
            heartrate: s.heartrate,
            cadence: s.cadence,
            speed: Math.round(s.speed * 10) / 10,
            wkg: myProfile?.weight ? Math.round(s.power / myProfile.weight * 10) / 10 : null,
            ride: this.stats.summary(),
            me: myFatigue,
            group,
            terrain: terrain && {
                source: terrain.source,
                routeName: terrain.routeName,
                step: terrain.step,
                profile: terrain.profile,
                current: terrain.current,
                next: terrain.next,
                climbs: terrain.climbs.map(c => [c.start, c.end, Math.round(c.grade * 1000) / 10]),
            },
            attack,
            ahead: ahead.slice(0, NEARBY_EACH_SIDE).reverse(),  // furthest ahead at the top
            behind: behind.slice(0, NEARBY_EACH_SIDE),
            courseId: s.courseId,
            eventSubgroupId: s.eventSubgroupId || 0,
            stateAge: now - me.updated,
        };
        if (this._record && now - (this._lastSnapRecord || 0) >= 1000) {
            this._lastSnapRecord = now;
            const brief = x => [x.athleteId, x.gap, x.dist, x.est ? 1 : 0, x.draft, x.battery, x.wkg1];
            this.recordLine({type: 'snap', d: snap.draft, eg: snap.eventSubgroupId, age: snap.stateAge,
                             bat: myFatigue.battery, grp: group, atk: attack?.text || null,
                             climb: terrain?.current ? ['on', terrain.current.toTop] :
                                 terrain?.next ? ['next', terrain.next.in] : null,
                             ahead: snap.ahead.map(brief), behind: snap.behind.map(brief)});
        }
        this.emit('snapshot', snap);
    }
}


// Recordings are gzip-compressed JSON lines when the name ends in .gz (~6x smaller).
function openRecording(file) {
    const out = FS.createWriteStream(file, {flags: 'a'});
    if (!file.endsWith('.gz')) {
        return out;
    }
    const gz = Zlib.createGzip({level: 6});
    gz.pipe(out);
    gz._draftmeterOut = out;
    return gz;
}


export function groupSummary(rows) {
    const near = rows.filter(r => Math.abs(r.gap) <= GROUP_GAP && r.battery != null && !r.fresh);
    if (!near.length) {
        return {count: 0, avgBattery: null, minBattery: null};
    }
    const bats = near.map(r => r.battery);
    return {
        count: near.length,
        avgBattery: Math.round(bats.reduce((a, b) => a + b, 0) / bats.length),
        minBattery: Math.min(...bats),
    };
}


// A nudge, not advice: you have clearly more in the tank than the riders around you, and either a
// climb is about to start / you're on one, or the group is running on empty.
export function attackHint(me, group, terrain) {
    if (me.battery == null || group.avgBattery == null || me.fresh) {
        return null;
    }
    const margin = me.battery - group.avgBattery;
    if (me.battery < 55 || margin < 15) {
        return null;
    }
    const onClimb = terrain?.current && terrain.current.toTop > 150;
    const climbSoon = terrain?.next && terrain.next.in <= 1000;
    const km = m => m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 50) * 50} m`;
    const vs = `you ${me.battery}% vs group ${group.avgBattery}%`;
    if (onClimb) {
        return {reason: 'climb', text: `On the climb, ${km(terrain.current.toTop)} to top · ${vs}`};
    }
    if (climbSoon) {
        return {reason: 'climb', text: `Climb in ${km(terrain.next.in)} · ${vs}`};
    }
    if (group.avgBattery <= 35) {
        return {reason: 'tired', text: `Group is on empty · ${vs}`};
    }
    return null;
}


export async function searchAthletes(api, query) {
    const results = await api.searchProfiles(query, {pageLimit: 1, limit: 20});
    return results.map(p => ({
        id: p.id,
        name: `${p.firstName || ''} ${p.lastName || ''}`.trim(),
        country: p.countryAlpha3 || '',
        avatar: p.imageSrc || null,
    }));
}
