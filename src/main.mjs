// Electron shell: menu-bar app + always-on-top transparent overlay over Zwift.
import Path from 'node:path';
import FS from 'node:fs';
import Process from 'node:process';
import {fileURLToPath} from 'node:url';
import {app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, safeStorage, screen,
    shell} from 'electron';
import {Engine, searchAthletes} from './engine.mjs';
import {DemoEngine} from './demo.mjs';

const __dirname = Path.dirname(fileURLToPath(import.meta.url));
const uiDir = Path.join(__dirname, '..', 'ui');
const isDemo = Process.argv.includes('--demo');

// Quieter terminal: hide protocol debug chatter (every HTTP fetch, undecoded packets) unless
// DRAFTMETER_DEBUG=1, and shrink the "Slow watching state" warning from a 70-line object dump to one line.
if (!Process.env.DRAFTMETER_DEBUG) {
    console.debug = () => {};
    const warn = console.warn.bind(console);
    console.warn = (msg, ...args) => {
        if (typeof msg === 'string' && msg.startsWith('Slow watching state update') && args[0]?.athleteId) {
            const st = args[0];
            return warn(`${msg} (draft ${st.draft} W, ${Math.round(st.speed ?? st._speed / 1e6)} km/h, via slow fallback)`);
        }
        return warn(msg, ...args);
    };
}
// Everything printed also goes to <userData>/draftmeter.log, so an app started from Finder (no terminal)
// can still be debugged. Truncated at startup when it passes 5 MB.
function initLogFile() {
    try {
        const file = Path.join(app.getPath('userData'), 'draftmeter.log');
        FS.mkdirSync(Path.dirname(file), {recursive: true});
        if (FS.existsSync(file) && FS.statSync(file).size > 5e6) {
            FS.renameSync(file, file + '.old');
        }
        const out = FS.createWriteStream(file, {flags: 'a'});
        out.on('error', () => {});
        for (const level of ['log', 'info', 'warn', 'error']) {
            const orig = console[level];
            console[level] = (...args) => {
                orig(...args);
                const text = args.map(a => typeof a === 'string' ? a : (a instanceof Error ? a.stack : (() => {
                    try { return JSON.stringify(a); } catch { return String(a); }
                })())).join(' ');
                out.write(`${new Date().toISOString()} ${level.toUpperCase()} ${text}\n`);
            };
        }
    } catch(e) {
        console.error('Log file unavailable:', e);
    }
}

const configFile = () => Path.join(app.getPath('userData'), 'config.json');

const defaultConfig = {
    monitorUsername: null,
    monitorPasswordEnc: null,
    athleteId: null,
    athleteName: null,
    overlayBounds: null,
    locked: false,
    gaugeMax: 300,
    show: {gauge: true, ride: true, terrain: true, nearby: true},
    layoutVersion: 2,
    showInDock: true,   // Dock (Mac) / taskbar (Windows) icon, so it's easy to find and quit
};

let config;
let engine;
let overlay;
let setupWin;
let tray;
let lastSnapshot;
let setupApi;   // ZwiftAPI logged in from the setup window (for athlete search)
let helpWin;


function loadConfig() {
    try {
        const saved = JSON.parse(FS.readFileSync(configFile(), 'utf8'));
        const cfg = {...defaultConfig, ...saved, show: {...defaultConfig.show, ...saved.show}};
        if ((cfg.layoutVersion || 1) < 2) {
            cfg.overlayBounds = null;  // v2 added climb + battery panels; old saved size is too small
            cfg.layoutVersion = 2;
        }
        return cfg;
    } catch {
        return structuredClone(defaultConfig);
    }
}


function saveConfig() {
    FS.mkdirSync(Path.dirname(configFile()), {recursive: true});
    FS.writeFileSync(configFile(), JSON.stringify(config, null, 2));
}


async function getPassword() {
    if (!config.monitorPasswordEnc) {
        return null;
    }
    try {
        const {result} = await safeStorage.decryptStringAsync(Buffer.from(config.monitorPasswordEnc, 'base64'));
        return result;
    } catch(e) {
        // e.g. keychain entry gone or app renamed: ask for the password again instead of failing.
        console.warn('Saved monitor password unreadable:', e.message);
        return null;
    }
}


function isConfigured() {
    return !!(config.monitorUsername && config.monitorPasswordEnc && config.athleteId);
}


// ---------- Engine ----------

// Every session is recorded (you + nearby riders, gzip, ~10 MB/hour) so a ride can be replayed later.
function newRideFile() {
    const dir = Path.join(app.getPath('userData'), 'rides');
    FS.mkdirSync(dir, {recursive: true});
    const old = FS.readdirSync(dir).filter(f => /\.jsonl(\.gz)?$/.test(f)).sort();
    for (const f of old.slice(0, Math.max(0, old.length - 10))) {
        FS.rmSync(Path.join(dir, f));  // keep the 10 most recent
    }
    const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '');
    return Path.join(dir, `${stamp}.jsonl.gz`);
}

async function startEngine() {
    const password = isDemo ? null : await getPassword();
    if (!isDemo && !password) {
        config.monitorPasswordEnc = null;
        saveConfig();
        openSetup();
        return;
    }
    stopEngine();
    engine = isDemo ? new DemoEngine() : new Engine({
        monitorUsername: config.monitorUsername,
        monitorPassword: password,
        athleteId: config.athleteId,
        recordFile: isDemo ? null : (Process.env.DRAFTMETER_RECORD || newRideFile()),
        learnedRoadsFile: Path.join(app.getPath('userData'), 'learned-roads.json'),
    });
    engine.on('snapshot', snap => {
        lastSnapshot = snap;
        overlay?.webContents.send('snapshot', snap);
        updateTrayTitle(snap);
    });
    engine.on('status', status => console.info('[engine]', status));
    try {
        await engine.start();
    } catch(e) {
        console.error('Engine start failed:', e);
        const msg = {status: 'error', error: e.message};
        lastSnapshot = msg;
        overlay?.webContents.send('snapshot', msg);
        setTimeout(() => engine && startEngine(), 30000);  // retry; e.g. network not up yet
    }
}


function stopEngine() {
    if (engine) {
        const e = engine;
        engine = null;
        e.removeAllListeners();
        return Promise.resolve(e.stop());
    }
    return Promise.resolve();
}


// ---------- Windows ----------

function createOverlay() {
    const area = screen.getPrimaryDisplay().workArea;
    const b = config.overlayBounds || {width: 360, height: 760, x: area.x + area.width - 320, y: area.y + 60};
    overlay = new BrowserWindow({
        ...b,
        show: false,  // shown with showInactive() below: never steal the keyboard from setup/Zwift
        minWidth: 220,
        minHeight: 160,
        frame: false,
        transparent: true,
        hasShadow: false,
        resizable: true,
        focusable: !config.locked,
        skipTaskbar: !config.showInDock,
        fullscreenable: false,
        backgroundColor: '#00000000',
        webPreferences: {
            preload: Path.join(__dirname, 'preload.cjs'),
            sandbox: true,
            contextIsolation: true,
        },
    });
    // 'screen-saver' level + visibleOnFullScreen keeps us above a full screen Zwift window.
    overlay.setAlwaysOnTop(true, 'screen-saver');
    // With a Dock icon, Electron must not flip the app to "accessory" mode (that would hide the icon).
    overlay.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true, skipTransformProcessType: config.showInDock});
    overlay.loadFile(Path.join(uiDir, 'overlay.html'));
    overlay.once('ready-to-show', () => overlay?.showInactive());
    overlay.webContents.on('did-finish-load', () => {
        pushOverlayConfig();
        if (lastSnapshot) {
            overlay.webContents.send('snapshot', lastSnapshot);
        }
    });
    const saveBounds = () => {
        config.overlayBounds = overlay.getBounds();
        saveConfig();
    };
    overlay.on('moved', saveBounds);
    overlay.on('resized', saveBounds);
    overlay.on('closed', () => {
        overlay = null;
        // Closing the overlay from the taskbar/Dock window list means "I'm done": quit the app.
        if (!quitting && config.showInDock) {
            app.quit();
        }
    });
    applyLock();
}


function pushOverlayConfig() {
    overlay?.webContents.send('config', {
        locked: config.locked,
        show: config.show,
        gaugeMax: config.gaugeMax,
        demo: isDemo,
    });
}


function applyLock() {
    if (!overlay) {
        return;
    }
    // Locked = clicks pass straight through to Zwift. Unlocked = drag/resize the overlay.
    overlay.setIgnoreMouseEvents(config.locked, {forward: true});
    overlay.setFocusable(!config.locked);
    pushOverlayConfig();
    rebuildTrayMenu();
}


function toggleLock() {
    config.locked = !config.locked;
    saveConfig();
    applyLock();
}


function toggleOverlay() {
    if (!overlay) {
        createOverlay();
    } else if (overlay.isVisible()) {
        overlay.hide();
    } else {
        overlay.showInactive();
    }
    rebuildTrayMenu();
}


// Make a normal window truly active so the keyboard goes to it. Without stealing app focus, macOS can
// leave keystrokes with another app (or the overlay) even after clicking a text field.
function bringToFront(win) {
    if (!win || win.isDestroyed()) {
        return;
    }
    if (Process.platform === 'darwin') {
        app.focus({steal: true});
    }
    win.show();
    win.moveTop();
    win.focus();
    win.webContents.focus();
}


function openSetup() {
    if (setupWin) {
        bringToFront(setupWin);
        return;
    }
    setupWin = new BrowserWindow({
        width: 460,
        height: 780,
        resizable: false,
        show: false,
        title: 'Draftmeter setup',
        backgroundColor: '#15171c',
        webPreferences: {
            preload: Path.join(__dirname, 'preload.cjs'),
            sandbox: true,
            contextIsolation: true,
        },
    });
    setupWin.loadFile(Path.join(uiDir, 'setup.html'));
    setupWin.once('ready-to-show', () => bringToFront(setupWin));
    if (Process.env.DRAFTMETER_TYPE_TEST) {
        // Dev aid: type into every text field with real key events and log what ended up in them.
        setupWin.webContents.once('did-finish-load', async () => {
            await new Promise(r => setTimeout(r, 800));
            const wc = setupWin.webContents;
            for (const [step, id] of [[1, 'user'], [1, 'pass'], [2, 'q'], [2, 'aid']]) {
                await wc.executeJavaScript(`document.querySelectorAll('.step').forEach(el => el.classList.toggle('on', +el.dataset.step === ${step}));
                    document.getElementById('${id}').value=''; document.getElementById('${id}').focus();`);
                for (const ch of 'ab1') {
                    wc.sendInputEvent({type: 'keyDown', keyCode: ch});
                    wc.sendInputEvent({type: 'char', keyCode: ch});
                    wc.sendInputEvent({type: 'keyUp', keyCode: ch});
                }
                await new Promise(r => setTimeout(r, 200));
                const v = await wc.executeJavaScript(`document.getElementById('${id}').value`);
                console.info(`[typetest] ${id}: "${v}" ${v === 'ab1' ? 'OK' : 'FAIL'}`);
            }
        });
    }
    setupWin.on('focus', () => console.info('[ui] setup window focused'));
    setupWin.on('closed', () => {
        setupWin = null;
        setupApi = null;
    });
    // Links (e.g. zwift.com sign-up) open in the real browser, never inside the app.
    setupWin.webContents.setWindowOpenHandler(({url}) => {
        if (url.startsWith('https://')) {
            shell.openExternal(url);
        }
        return {action: 'deny'};
    });
}


function openHelp() {
    if (helpWin) {
        bringToFront(helpWin);
        return;
    }
    helpWin = new BrowserWindow({
        width: 560,
        height: 760,
        show: false,
        title: 'How to use Draftmeter',
        backgroundColor: '#15171c',
        webPreferences: {sandbox: true, contextIsolation: true},
    });
    helpWin.loadFile(Path.join(uiDir, 'help.html'));
    helpWin.once('ready-to-show', () => bringToFront(helpWin));
    helpWin.on('closed', () => helpWin = null);
    helpWin.webContents.setWindowOpenHandler(({url}) => {
        if (url.startsWith('https://')) {
            shell.openExternal(url);
        }
        return {action: 'deny'};
    });
}


// ---------- Tray (menu bar) ----------

function updateTrayTitle(snap) {
    if (!tray) {
        return;
    }
    const title = snap.status === 'live' ? ` ${snap.draft}W draft` : ' Draftmeter';
    if (title !== tray._lastTitle) {
        if (Process.platform === 'darwin') {
            tray.setTitle(title);  // live draft right in the menu bar
        } else {
            tray.setToolTip(`Draftmeter -${title}`);
        }
        tray._lastTitle = title;
    }
}


function rebuildTrayMenu() {
    if (!tray) {
        return;
    }
    const sectionItem = (key, label) => ({
        label,
        type: 'checkbox',
        checked: config.show[key],
        click: () => {
            config.show[key] = !config.show[key];
            saveConfig();
            pushOverlayConfig();
        },
    });
    tray.setContextMenu(Menu.buildFromTemplate([
        {label: isDemo ? 'Draftmeter (DEMO data)' : `Watching: ${config.athleteName || config.athleteId || '—'}`,
         enabled: false},
        {type: 'separator'},
        {label: overlay?.isVisible() ? 'Hide overlay' : 'Show overlay', accelerator: 'CmdOrCtrl+Shift+H',
         click: toggleOverlay},
        {label: config.locked ? 'Unlock overlay (move/resize)' : 'Lock overlay (click-through)',
         accelerator: 'CmdOrCtrl+Shift+D', click: toggleLock},
        {label: 'Reset ride stats', click: () => engine?.resetStats()},
        {type: 'separator'},
        sectionItem('gauge', 'Show draft gauge'),
        sectionItem('ride', 'Show ride draft stats'),
        sectionItem('terrain', 'Show climb ahead'),
        sectionItem('nearby', 'Show nearby riders + battery'),
        {label: 'Gauge max', submenu: [200, 300, 400, 500].map(v => ({
            label: `${v} W`, type: 'radio', checked: config.gaugeMax === v,
            click: () => {
                config.gaugeMax = v;
                saveConfig();
                pushOverlayConfig();
            },
        }))},
        {type: 'separator'},
        {label: 'How to use…', click: openHelp},
        {label: 'Settings…', click: openSetup},
        {label: 'Open at login', type: 'checkbox', visible: app.isPackaged,
         checked: app.isPackaged && app.getLoginItemSettings().openAtLogin,
         click: item => app.setLoginItemSettings({openAtLogin: item.checked})},
        {label: Process.platform === 'darwin' ? 'Show in Dock' : 'Show in taskbar', type: 'checkbox',
         checked: config.showInDock, click: toggleShowInDock},
        {label: 'Show logs & ride recordings', click: () => shell.openPath(app.getPath('userData'))},
        {type: 'separator'},
        {label: 'Quit Draftmeter', accelerator: 'CmdOrCtrl+Q', click: () => app.quit()},
    ]));
}


// ---------- IPC from setup window ----------

ipcMain.handle('setup:help', () => openHelp());

ipcMain.handle('setup:get', () => ({
    monitorUsername: config.monitorUsername,
    hasPassword: !!config.monitorPasswordEnc,
    athleteId: config.athleteId,
    athleteName: config.athleteName,
}));

ipcMain.handle('setup:login', async (ev, {username, password}) => {
    try {
        if (!password && username === config.monitorUsername) {
            password = await getPassword();
        }
        setupApi = await Engine.login(username, password);
        config.monitorUsername = username;
        config.monitorPasswordEnc = (await safeStorage.encryptStringAsync(password)).toString('base64');
        saveConfig();
        const p = setupApi.profile;
        return {ok: true, id: p.id, name: `${p.firstName} ${p.lastName}`};
    } catch(e) {
        return {ok: false, error: e.message};
    }
});

ipcMain.handle('setup:search', async (ev, query) => {
    if (!setupApi) {
        return {ok: false, error: 'Log in with the monitor account first.'};
    }
    try {
        return {ok: true, results: await searchAthletes(setupApi, query)};
    } catch(e) {
        return {ok: false, error: e.message};
    }
});

ipcMain.handle('setup:save', async (ev, {athleteId, athleteName}) => {
    if (setupApi && Number(athleteId) === setupApi.profile.id) {
        return {ok: false, error: 'That is the monitor account itself. Pick the account you ride with.'};
    }
    const firstTime = !config.athleteId;
    config.athleteId = Number(athleteId);
    config.athleteName = athleteName || null;
    saveConfig();
    rebuildTrayMenu();
    if (!overlay) {
        createOverlay();
    }
    startEngine();
    return {ok: true, firstTime};  // the wizard shows its "You're set" page
});


// ---------- App lifecycle ----------

// Diagnostic: `npx electron . --diag [--random]` measures how often the watched rider's state arrives
// via the live UDP stream vs the slow HTTP fallback. No windows. Prints a report and quits.
async function runDiag() {
    const random = Process.argv.includes('--random');
    const seconds = Number(Process.env.DRAFTMETER_DIAG_SECONDS || 60);
    const e = new Engine({
        monitorUsername: config.monitorUsername,
        monitorPassword: await getPassword(),
        athleteId: config.athleteId,
        randomWatch: random ? 6 : undefined,  // 6 = Watopia
        learnedRoadsFile: Path.join(app.getPath('userData'), 'learned-roads.json'),
        recordFile: Process.env.DRAFTMETER_RECORD || null,
    });
    const drafts = [];
    let lastSnap = null;
    e.on('snapshot', s => {
        if (s.status === 'live') {
            drafts.push(s.draft);
            lastSnap = s;
        }
    });
    await e.start();
    const report = () => {
        const d = e.diag;
        const secs = (Date.now() - d.since) / 1000;
        const live = drafts.length;
        console.log(`[diag] ${secs.toFixed(0)}s watching=${e.watchingId} status=${e.status} ` +
            `selfUdp=${d.selfUdp} (${(d.selfUdp / secs).toFixed(2)}/s) selfApi=${d.selfApi} ` +
            `othersUdp=${d.othersUdp} riders=${e.tracks.size} packets=${d.packets} ` +
            `liveSnapshots=${live} lastDraft=${drafts.at(-1)}`);
        if (lastSnap) {
            const t = lastSnap.terrain;
            const rows = [...lastSnap.ahead, ...lastSnap.behind];
            console.log(`[diag]   terrain=${t ? `${t.source}:${t.routeName} next=${JSON.stringify(t.next)} ` +
                `cur=${JSON.stringify(t.current)}` : 'none'} myBattery=${lastSnap.me?.battery} ` +
                `group=${JSON.stringify(lastSnap.group)} nearby=${rows.length} ` +
                `batteries=${rows.map(r => r.battery ?? '?').join(',')} attack=${lastSnap.attack?.text || '-'}`);
        }
    };
    const iv = setInterval(report, 10000);
    if (Process.argv.includes('--heal-test')) {
        // Exercise both self-repair actions mid-stream and check data keeps flowing afterwards.
        setTimeout(() => (console.log('[diag] forcing udp-reset'), e.monitor.setUDPChannel()), 20000);
        setTimeout(() => (console.log('[diag] forcing reconnect'), e.monitor.reconnect()), 40000);
    }
    setTimeout(() => {
        clearInterval(iv);
        report();
        e.stop().finally(() => app.exit(0));
    }, seconds * 1000);
}

// macOS app menu: Quit (⌘Q), settings, and an Edit menu so copy/paste works in the setup fields.
function appMenu() {
    return Menu.buildFromTemplate([
        {label: 'Draftmeter', submenu: [
            {label: 'How to use…', click: openHelp},
            {label: 'Settings…', accelerator: 'Cmd+,', click: openSetup},
            {type: 'separator'},
            {label: 'Show / hide overlay', accelerator: 'CmdOrCtrl+Shift+H', click: toggleOverlay},
            {label: 'Lock / unlock overlay', accelerator: 'CmdOrCtrl+Shift+D', click: toggleLock},
            {type: 'separator'},
            {role: 'hide', label: 'Hide Draftmeter'},
            {role: 'quit', label: 'Quit Draftmeter'},
        ]},
        {role: 'editMenu'},
        {role: 'windowMenu'},
    ]);
}


function applyDockVisibility() {
    if (Process.platform !== 'darwin') {
        return;
    }
    if (config.showInDock) {
        app.dock.show();
        app.dock.setMenu(Menu.buildFromTemplate([
            {label: 'Show / hide overlay', click: toggleOverlay},
            {label: 'Lock / unlock overlay', click: toggleLock},
            {label: 'Settings…', click: openSetup},
            {label: 'How to use…', click: openHelp},
        ]));
    } else {
        // Menu-bar-only mode: the overlay can float over a full-screen Zwift more reliably.
        app.dock.hide();
    }
}


function toggleShowInDock() {
    config.showInDock = !config.showInDock;
    saveConfig();
    applyDockVisibility();
    if (overlay) {
        overlay.setSkipTaskbar(!config.showInDock);
        overlay.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true,
                                                 skipTransformProcessType: config.showInDock});
    }
    rebuildTrayMenu();
}


// Clicking the Dock icon: bring up whatever is useful.
app.on('activate', () => {
    if (!config) {
        return;
    }
    if (!isConfigured()) {
        openSetup();
    } else if (!overlay) {
        createOverlay();
    } else {
        overlay.showInactive();
        rebuildTrayMenu();
    }
});

// One copy at a time: opening the app again just brings up settings / the overlay.
if (!Process.argv.includes('--diag') && !app.requestSingleInstanceLock()) {
    app.exit(0);
}
app.on('second-instance', () => {
    if (!isConfigured()) {
        openSetup();
    } else if (!overlay) {
        createOverlay();
    } else {
        overlay.showInactive();
        rebuildTrayMenu();
    }
});

app.whenReady().then(() => {
    initLogFile();
    config = loadConfig();
    if (Process.argv.includes('--diag')) {
        runDiag().catch(err => {
            console.error('[diag] failed:', err);
            app.exit(1);
        });
        return;
    }
    const isMac = Process.platform === 'darwin';
    if (isMac) {
        applyDockVisibility();
    }
    // macOS: black "template" glyph that adapts to light/dark menu bars. Windows: coloured icon.
    const trayIcon = nativeImage.createFromPath(Path.join(uiDir, isMac ? 'trayTemplate.png' : 'tray.png'));
    if (isMac) {
        trayIcon.setTemplateImage(true);
    } else {
        Menu.setApplicationMenu(null);  // no File/Edit/View bar on Windows windows
    }
    if (isMac) {
        Menu.setApplicationMenu(appMenu());
    }
    tray = new Tray(trayIcon.isEmpty() ? nativeImage.createEmpty() : trayIcon);
    tray.setToolTip('Draftmeter');
    if (isMac) {
        tray.setTitle(' Draftmeter');
    } else {
        tray.on('click', () => tray.popUpContextMenu());  // Windows only opens the menu on right-click
    }
    rebuildTrayMenu();
    globalShortcut.register('CmdOrCtrl+Shift+D', toggleLock);
    globalShortcut.register('CmdOrCtrl+Shift+H', toggleOverlay);
    if (isDemo || isConfigured()) {
        createOverlay();
        startEngine();
    } else {
        openSetup();
    }
    // Dev aid: DRAFTMETER_CAPTURE=/path/out.png npm run demo -> screenshot of the windows, then quit.
    if (Process.env.DRAFTMETER_CAPTURE) {
        if (Process.env.DRAFTMETER_CAPTURE_HELP) {
            openHelp();
        }
        setTimeout(async () => {
            const out = Process.env.DRAFTMETER_CAPTURE;
            if (overlay) {
                FS.writeFileSync(out, (await overlay.webContents.capturePage()).toPNG());
            }
            if (setupWin) {
                FS.writeFileSync(out.replace(/\.png$/, '-setup.png'), (await setupWin.webContents.capturePage()).toPNG());
            }
            if (helpWin) {
                FS.writeFileSync(out.replace(/\.png$/, '-help.png'), (await helpWin.webContents.capturePage()).toPNG());
            }
            app.quit();
        }, Number(Process.env.DRAFTMETER_CAPTURE_DELAY || 6000));
    }
});

app.on('window-all-closed', () => {
    // Stay alive in the menu bar.
});

let quitting = false;
app.on('will-quit', ev => {
    if (quitting) {
        return;
    }
    // Hold the quit until the ride recording is flushed, otherwise the gzip file ends up truncated.
    ev.preventDefault();
    quitting = true;
    globalShortcut.unregisterAll();
    stopEngine().finally(() => app.exit(0));
});
