// Renders the app icon and tray icons from SVG with Electron (run: npx electron scripts/make-icons.mjs).
import {app, BrowserWindow} from 'electron';
import FS from 'node:fs';
import Path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = Path.join(Path.dirname(fileURLToPath(import.meta.url)), '..');

// Gauge geometry shared by all icons: 240° arc, needle pointing at ~60% (a good draft).
function gauge({size, stroke, arcColor, trackColor, needle, bg}) {
    const c = 50, r = 34, a0 = 150, sweep = 240, frac = 0.62;
    const pt = (deg, rr) => [c + rr * Math.cos(deg * Math.PI / 180), c + 8 + rr * Math.sin(deg * Math.PI / 180)];
    const arc = (from, to) => {
        const [x1, y1] = pt(from, r), [x2, y2] = pt(to, r);
        return `M${x1} ${y1} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`;
    };
    const [nx, ny] = pt(a0 + sweep * frac, r - 10);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
      <defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0" stop-color="#2dd4bf"/><stop offset="0.6" stop-color="#f59e0b"/><stop offset="1" stop-color="#ef4444"/>
      </linearGradient>
      <linearGradient id="bg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#232833"/><stop offset="1" stop-color="#0e1015"/></linearGradient></defs>
      ${bg ? '<rect x="6" y="6" width="88" height="88" rx="20" fill="url(#bg)"/>' : ''}
      ${trackColor ? `<path d="${arc(a0, a0 + sweep)}" fill="none" stroke="${trackColor}" stroke-width="${stroke}" stroke-linecap="round"/>` : ''}
      <path d="${arc(a0, a0 + sweep * (arcColor === 'url(#g)' ? 1 : frac))}" fill="none" stroke="${arcColor}" stroke-width="${stroke}" stroke-linecap="round"/>
      <line x1="${c}" y1="${c + 8}" x2="${nx}" y2="${ny}" stroke="${needle}" stroke-width="${stroke * 0.55}" stroke-linecap="round"/>
      <circle cx="${c}" cy="${c + 8}" r="${stroke * 0.6}" fill="${needle}"/>
    </svg>`;
}

// Always render at 512 px and downscale: tiny offscreen windows fail to load.
async function render(makeSvg, size, out) {
    const R = Math.max(512, size);
    const svg = makeSvg(R);
    const win = new BrowserWindow({width: R, height: R, show: false, transparent: true, frame: false,
                                   useContentSize: true, webPreferences: {offscreen: true}});
    const tmp = Path.join(app.getPath('temp'), `draftmeter-icon-${Date.now()}.html`);
    FS.writeFileSync(tmp, `<html><body style="margin:0;background:transparent">${svg}</body></html>`);
    await win.loadFile(tmp);
    FS.rmSync(tmp);
    await new Promise(r => setTimeout(r, 300));
    const img = await win.webContents.capturePage({x: 0, y: 0, width: R, height: R});
    FS.writeFileSync(out, img.resize({width: size, height: size, quality: 'best'}).toPNG());
    win.destroy();
    console.log('wrote', Path.relative(root, out), size);
}

app.on('window-all-closed', () => {});  // keep running between renders

app.whenReady().then(async () => {
    app.dock?.hide();
    const appIcon = s => gauge({size: s, stroke: 9, arcColor: 'url(#g)', trackColor: null, needle: '#f2f4f7', bg: true});
    await render(appIcon, 1024, Path.join(root, 'build', 'icon.png'));
    // macOS menu bar: black "template" glyph, macOS recolors it for light/dark menu bars.
    const tmpl = s => gauge({size: s, stroke: 12, arcColor: '#000', trackColor: 'rgba(0,0,0,0.35)', needle: '#000', bg: false});
    await render(tmpl, 16, Path.join(root, 'ui', 'trayTemplate.png'));
    await render(tmpl, 32, Path.join(root, 'ui', 'trayTemplate@2x.png'));
    // Windows tray: colored glyph (template images are a macOS thing).
    const win = s => gauge({size: s, stroke: 12, arcColor: '#2dd4bf', trackColor: 'rgba(255,255,255,0.45)', needle: '#ffffff', bg: false});
    await render(win, 16, Path.join(root, 'ui', 'tray.png'));
    await render(win, 32, Path.join(root, 'ui', 'tray@2x.png'));
    app.quit();
});
