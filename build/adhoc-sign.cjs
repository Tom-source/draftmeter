// macOS: give the app an ad-hoc signature after packing. Without any signature, a downloaded
// Apple Silicon app shows "Draftmeter is damaged and can't be opened". With it, macOS shows the
// normal "unidentified developer" prompt, which friends can get past via Privacy & Security.
const {execFileSync} = require('node:child_process');
const path = require('node:path');

exports.default = async function(context) {
    if (context.electronPlatformName !== 'darwin') {
        return;
    }
    const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], {stdio: 'inherit'});
    console.log('  • ad-hoc signed', app);
};
