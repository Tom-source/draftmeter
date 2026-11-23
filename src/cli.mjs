// Terminal test harness: prints your live draft once a second. No Electron needed.
//
//   MON_USERNAME=you+zwiftmon@gmail.com MON_PASSWORD=... ATHLETE_ID=123456 npm run cli
//   npm run cli -- --demo        (fake data)
//   MON_USERNAME=... MON_PASSWORD=... npm run cli -- --search "Your Name"
import Process from 'node:process';
import {Engine, searchAthletes} from './engine.mjs';
import {DemoEngine} from './demo.mjs';

const args = Process.argv.slice(2);

async function main() {
    if (args[0] === '--search') {
        const api = await Engine.login(Process.env.MON_USERNAME, Process.env.MON_PASSWORD);
        for (const x of await searchAthletes(api, args.slice(1).join(' '))) {
            console.log(String(x.id).padStart(10), ' ', x.name, x.country);
        }
        Process.exit(0);
    }
    const engine = args.includes('--demo') ? new DemoEngine() : new Engine({
        monitorUsername: Process.env.MON_USERNAME,
        monitorPassword: Process.env.MON_PASSWORD,
        athleteId: Process.env.ATHLETE_ID,
    });
    let last = 0;
    engine.on('status', s => console.log(`[status] ${s}`));
    engine.on('snapshot', snap => {
        if (Date.now() - last < 1000) {
            return;
        }
        last = Date.now();
        if (snap.status !== 'live') {
            return;
        }
        const near = [...snap.ahead, ...snap.behind]
            .map(x => `${x.name || x.athleteId} ${x.gap > 0 ? '+' : ''}${x.gap}s`).join(' | ');
        console.log(`draft ${String(snap.draft).padStart(3)}W  power ${snap.power}W  hr ${snap.heartrate}` +
                    `  cad ${snap.cadence}  ${snap.speed}km/h  | avg draft ${snap.ride.avgDraft}W` +
                    ` saved ${snap.ride.draftKj}kJ ${snap.ride.draftPct}% | ${near}`);
    });
    await engine.start();
    Process.on('SIGINT', () => {
        engine.stop();
        Process.exit(0);
    });
}

main().catch(e => {
    console.error(e.message || e);
    Process.exit(1);
});
