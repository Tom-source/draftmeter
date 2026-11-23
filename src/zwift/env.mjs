// draftmeter: slim replacement for the upstream env.mjs. Only course names are needed by zwift.mjs.
import FS from 'node:fs';
import Path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = Path.dirname(fileURLToPath(import.meta.url));

export const worldMetas = {};
try {
    for (const x of JSON.parse(FS.readFileSync(Path.join(__dirname, 'data', 'worldlist.json')))) {
        worldMetas[x.courseId] = x;
    }
} catch(e) {
    console.error('World list load error:', e);
}
