// Run with: node tests/dialog-fullscreen-browser.test.cjs
// Uses an isolated temporary profile; DIALOG_FULLSCREEN_BROWSER can select a Chromium binary.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const test = require('node:test');
const vm = require('node:vm');

const browser = process.env.DIALOG_FULLSCREEN_BROWSER || [
    '/opt/vivaldi-snapshot/vivaldi-bin', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'
].find(candidate => fs.existsSync(candidate));

async function runBrowserSuite(DialogFullscreen, childDocument) {
    const results = [];
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const until = async predicate => {
        for (let i = 0; i < 100; i++) {
            if (await predicate()) return;
            await sleep(10);
        }
        throw new Error('Timed out waiting for frame fullscreen state');
    };
    const check = async (name, callback) => {
        try { await callback(); results.push({name, passed: true}); }
        catch (error) { results.push({name, passed: false, error: error.message}); }
        finally {
            await document.exitFullscreen();
            document.querySelectorAll('.fixture').forEach(element => element.remove());
        }
    };
    const makePlayer = (root = document.body) => {
        const player = document.createElement('div');
        player.className = 'fixture';
        player.style.cssText = 'width:240px;height:130px;background:blue';
        root.append(player);
        return player;
    };
    const makeFrame = async (crossOrigin, nested = false) => {
        const frame = document.createElement('iframe');
        frame.className = 'fixture';
        frame.style.cssText = 'width:300px;height:180px';
        frame.allowFullscreen = true;
        let content = childDocument;
        if (nested) {
            content = content.replace('<body>', '<body><iframe allowfullscreen src="data:text/html,' + encodeURIComponent(childDocument) + '"></iframe>');
        }
        const loaded = new Promise(resolve => frame.addEventListener('load', resolve, {once: true}));
        if (crossOrigin) frame.src = 'data:text/html,' + encodeURIComponent(content);
        else frame.srcdoc = content;
        document.body.append(frame);
        await loaded;
        return frame;
    };
    let requestId = 0;
    const command = (target, action) => new Promise((resolve, reject) => {
        const id = ++requestId;
        const timeout = setTimeout(() => { window.removeEventListener('message', listener); reject(new Error('Frame command timed out: ' + action)); }, 2000);
        const listener = event => {
            if (event.source !== target || event.data?.fixture !== 'result' || event.data.id !== id) return;
            clearTimeout(timeout);
            window.removeEventListener('message', listener);
            if (event.data.error) reject(new Error(event.data.error));
            else resolve(event.data);
        };
        window.addEventListener('message', listener);
        target.postMessage({fixture: 'command', action, id}, '*');
    });
    const fillsViewport = element => {
        const rect = element.getBoundingClientRect();
        return Math.abs(rect.width - innerWidth) < 1 && Math.abs(rect.height - innerHeight) < 1;
    };
    const nativeFullscreen = () => Object.getOwnPropertyDescriptor(Document.prototype, 'fullscreenElement').get.call(document);
    // Model chrome.dom in this standalone page; production uses Vivaldi's native API.
    const roots = new WeakMap(), attachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
        const root = attachShadow.call(this, init); roots.set(this, root); return root;
    };
    globalThis.chrome ||= {};
    chrome.dom = {openOrClosedShadowRoot: element => roots.get(element) || element.shadowRoot};
    DialogFullscreen.installController();
    DialogFullscreen.installInPage();

    await check('normal fullscreen toggles without changing inline styles', async () => {
        const player = makePlayer(), originalStyle = player.getAttribute('style');
        await player.requestFullscreen();
        assert(fillsViewport(player), 'Player does not fill viewport');
        assert(document.fullscreenElement === player && document.fullscreen, 'Missing fullscreen state');
        assert(nativeFullscreen() === null, 'Native fullscreen was activated');
        await document.exitFullscreen();
        assert(!document.fullscreen && document.fullscreenElement === null, 'Exit did not clear state');
        assert(player.getAttribute('style') === originalStyle && !player.hasAttribute('popover'), 'Original attributes were not restored');
    });
    await check('a fullscreen video preserves its picture instead of keeping the site cover crop and device mask', async () => {
        const video = document.createElement('video');
        video.className = 'fixture';
        // App Store previews use cover and a device mask until native :fullscreen matches.
        video.style.cssText = 'width:240px;height:130px;object-fit:cover;object-position:top left;border-radius:12.8% / 5.7%;mask-image:linear-gradient(black,black)';
        video.poster = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="green"/><rect width="100" height="900" fill="red"/><rect x="1500" width="100" height="900" fill="blue"/></svg>');
        document.body.append(video);
        const originalStyle = video.getAttribute('style');
        await video.requestFullscreen();
        const computed = getComputedStyle(video);
        assert(fillsViewport(video), 'Video box should fill viewport');
        assert(computed.objectFit === 'contain', 'Video still crops or stretches its picture');
        assert(computed.objectPosition === '50% 50%', 'Video picture is not centered');
        assert(computed.borderRadius === '0px' && computed.maskImage === 'none', 'Device mask still clips video corners');
        await document.exitFullscreen();
        assert(video.getAttribute('style') === originalStyle, 'Site video styles were not restored on exit');
    });
    await check('nested closed shadow player fills viewport and reports retargeted state and events', async () => {
        const host = makePlayer(), outer = host.attachShadow({mode: 'open'});
        const innerHost = document.createElement('div'); outer.append(innerHost);
        const inner = innerHost.attachShadow({mode: 'closed'}), player = makePlayer(inner);
        let events = 0;
        const listener = () => events++;
        document.addEventListener('fullscreenchange', listener);
        try {
            await player.requestFullscreen();
            assert(fillsViewport(player), 'Shadow player does not fill viewport');
            assert(document.fullscreenElement === host, 'Document getter should return outer host');
            assert(outer.fullscreenElement === innerHost && inner.fullscreenElement === player, 'Shadow getters are incorrect');
            await document.exitFullscreen();
            assert(events === 2, 'Fullscreen events did not cross shadow boundaries');
            assert(inner.fullscreenElement === null && !inner.querySelector('style'), 'Shadow state or styles leaked');
        } finally { document.removeEventListener('fullscreenchange', listener); }
    });
    await check('removing player or shadow host clears state without reading a getter', async () => {
        const player = makePlayer(); await player.requestFullscreen(); player.remove(); await sleep(0);
        assert(!document.documentElement.hasAttribute('data-dialog-fullscreen'), 'Removed player left stale marker');
        assert(!document.fullscreen && document.fullscreenElement === null, 'Removed player left stale API state');
        assert(!DialogFullscreen.exitInPage(), 'Removal should not swallow the next Escape');
        const host = makePlayer(), shadow = host.attachShadow({mode: 'closed'}), nested = makePlayer(shadow);
        await nested.requestFullscreen(); host.remove(); await sleep(0);
        assert(!document.documentElement.hasAttribute('data-dialog-fullscreen'), 'Removed shadow host left stale marker');
    });
    await check('externally hidden popovers clear fullscreen state', async () => {
        for (const hide of [player => player.hidePopover(), player => player.removeAttribute('popover')]) {
            const player = makePlayer(); await player.requestFullscreen(); hide(player); await sleep(20);
            assert(!document.documentElement.hasAttribute('data-dialog-fullscreen'), 'Hidden player left stale marker');
        }
    });
    await check('cancelled beforetoggle rejects fullscreen without leaving state', async () => {
        const player = makePlayer();
        player.addEventListener('beforetoggle', event => { if (event.newState === 'open') event.preventDefault(); });
        let rejected = false;
        try { await player.requestFullscreen(); } catch { rejected = true; }
        assert(rejected && !document.fullscreen && !player.hasAttribute('popover'), 'Cancelled entry was reported as successful');
    });
    await check('an existing open popover is restored on exit', async () => {
        const player = makePlayer(); player.setAttribute('popover', 'auto'); player.showPopover();
        await player.requestFullscreen(); await document.exitFullscreen();
        assert(player.getAttribute('popover') === 'auto' && player.matches(':popover-open'), 'Existing popover was not restored');
    });
    for (const crossOrigin of [false, true]) {
        await check((crossOrigin ? 'cross-origin' : 'same-origin') + ' iframe expands and Escape in child resets both documents', async () => {
            const frame = await makeFrame(crossOrigin);
            const entered = await command(frame.contentWindow, 'enter');
            await until(() => document.fullscreenElement === frame);
            assert(fillsViewport(frame) && entered.fillsViewport, 'Iframe or its player does not fill viewport');
            assert(!entered.native && nativeFullscreen() === null, 'Native fullscreen was activated');
            await command(frame.contentWindow, 'escape');
            await until(() => !document.fullscreen);
            assert(frame.getBoundingClientRect().width < innerWidth, 'Iframe did not shrink');
            assert(DialogFullscreen.exitInPage(), 'The same Escape must not close the dialog');
            await sleep(350);
            assert(!DialogFullscreen.exitInPage(), 'A later Escape must be able to close the dialog');
        });
    }
    await check('Escape in top document exits cross-origin player', async () => {
        const frame = await makeFrame(true);
        await command(frame.contentWindow, 'enter'); await until(() => document.fullscreen);
        assert(DialogFullscreen.exitInPage(), 'Active player was not detected');
        const state = await command(frame.contentWindow, 'status');
        assert(!state.fullscreen && !document.fullscreen, 'Escape left a document fullscreen');
    });
    await check('rapid child player replacement ignores delayed exits from previous session', async () => {
        const frame = await makeFrame(true);
        await command(frame.contentWindow, 'enter'); await until(() => document.fullscreen);
        await command(frame.contentWindow, 'switch'); await sleep(50);
        const state = await command(frame.contentWindow, 'status');
        assert(state.fullscreen && document.fullscreenElement === frame, 'A delayed exit closed the replacement player');
    });
    for (const crossOrigin of [false, true]) {
        await check((crossOrigin ? 'cross-origin' : 'same-origin') + ' iframe in a closed shadow root expands and restores', async () => {
            const host = makePlayer(), shadow = host.attachShadow({mode: 'closed'});
            const nested = document.createElement('div'); shadow.append(nested);
            const inner = nested.attachShadow({mode: 'closed'});
            const frame = document.createElement('iframe');
            frame.style.cssText = 'width:240px;height:130px';
            const loaded = new Promise(resolve => frame.addEventListener('load', resolve, {once: true}));
            if (crossOrigin) frame.src = 'data:text/html,' + encodeURIComponent(childDocument);
            else frame.srcdoc = childDocument;
            inner.append(frame); await loaded;
            await command(frame.contentWindow, 'enter');
            await until(() => document.fullscreen);
            assert(fillsViewport(frame), 'Closed shadow iframe did not expand');
            assert(document.fullscreenElement === host && shadow.fullscreenElement === nested && inner.fullscreenElement === frame, 'Closed iframe state was not retargeted');
            await command(frame.contentWindow, 'escape');
            await until(() => !document.fullscreen);
            assert(frame.getBoundingClientRect().width < innerWidth, 'Closed iframe did not shrink');
            assert(!host.hasAttribute('data-dialog-fullscreen-host') && !nested.hasAttribute('data-dialog-fullscreen-host'), 'Host markers leaked');
        });
    }
    await check('nested cross-origin frames expand and exit through every ancestor', async () => {
        const frame = await makeFrame(true, true), grandchild = frame.contentWindow.frames[0];
        await command(grandchild, 'enter'); await until(() => document.fullscreenElement === frame);
        assert(fillsViewport(frame), 'Top ancestor was not expanded');
        const middle = await command(frame.contentWindow, 'status');
        assert(middle.fullscreen && middle.fillsViewport, 'Middle ancestor was not expanded');
        assert(DialogFullscreen.exitInPage(), 'Nested fullscreen was not detected');
        await until(async () => !(await command(grandchild, 'status')).fullscreen);
        assert(!document.fullscreen, 'Nested exit left top document fullscreen');
    });
    await check('iframe navigation and removal clear ancestor state', async () => {
        const frame = await makeFrame(false);
        await command(frame.contentWindow, 'enter'); await until(() => document.fullscreen);
        const loaded = new Promise(resolve => frame.addEventListener('load', resolve, {once: true}));
        frame.srcdoc = '<!doctype html><p>Navigated</p>'; await loaded; await sleep(20);
        assert(!document.fullscreen, 'Navigated iframe left stale state');
        const removed = await makeFrame(true);
        await command(removed.contentWindow, 'enter'); await until(() => document.fullscreen);
        removed.remove(); await sleep(20);
        assert(!document.documentElement.hasAttribute('data-dialog-fullscreen'), 'Removed iframe left stale marker');
    });
    document.getElementById('results').textContent = JSON.stringify(results);
}

function childFixture(controller, install) {
    controller();
    install();
    let player = document.createElement('div');
    player.style.cssText = 'width:200px;height:100px'; document.body.append(player);
    window.addEventListener('message', async event => {
        if (event.data?.fixture !== 'command') return;
        const {action, id} = event.data;
        try {
            if (action === 'enter') await player.requestFullscreen();
            if (action === 'exit') await document.exitFullscreen();
            if (action === 'escape') window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', cancelable: true}));
            if (action === 'switch') {
                const replacement = document.createElement('div'); document.body.append(replacement);
                await replacement.requestFullscreen(); player.remove(); player = replacement;
            }
            const element = document.fullscreenElement, rect = element?.getBoundingClientRect();
            event.source.postMessage({fixture: 'result', id, fullscreen: document.fullscreen,
                fillsViewport: Boolean(rect && Math.abs(rect.width - innerWidth) < 1 && Math.abs(rect.height - innerHeight) < 1),
                native: Boolean(Object.getOwnPropertyDescriptor(Document.prototype, 'fullscreenElement').get.call(document))}, '*');
        } catch (error) { event.source.postMessage({fixture: 'result', id, error: error.message}, '*'); }
    });
}

test('dialog fullscreen browser regressions', {skip: !browser && 'No Chromium binary found'}, () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'dialog.js'), 'utf8');
    const classSource = source.slice(source.indexOf('    class DialogFullscreen {'), source.indexOf('    class WebsiteInjectionUtils {'));
    const functions = vm.runInNewContext(classSource + '\nDialogFullscreen');
    const installSource = functions.installController.toString() + ',' + functions.installInPage.toString();
    const childDocument = '<!doctype html><body><script>(' + childFixture.toString() + ')(' + installSource + ');</script>';
    const html = '<!doctype html><meta charset="utf-8"><body style="margin:0"><pre id="results"></pre><script>' + classSource + '\n(' + runBrowserSuite.toString() + ')(DialogFullscreen,' + JSON.stringify(childDocument).replace(/</g, '\\u003c') + ');</script>';
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dialog-fullscreen-tests-'));
    try {
        const file = path.join(directory, 'tests.html'); fs.writeFileSync(file, html);
        const output = execFileSync(browser, ['--disable-vivaldi', '--headless', '--no-sandbox', '--disable-gpu',
            '--disable-background-networking', '--no-first-run', '--user-data-dir=' + path.join(directory, 'profile'),
            '--virtual-time-budget=10000', '--dump-dom', 'file://' + file], {timeout: 30000, maxBuffer: 4 * 1024 * 1024}).toString();
        const match = output.match(/<pre id="results">([^<]+)<\/pre>/);
        assert.ok(match, 'Browser suite did not finish');
        const results = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&'));
        for (const result of results) {
            console.log((result.passed ? 'PASS ' : 'FAIL ') + result.name + (result.error ? ': ' + result.error : ''));
        }
        assert.equal(results.length, 15);
        assert.deepEqual(results.filter(result => !result.passed), []);
    } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});
