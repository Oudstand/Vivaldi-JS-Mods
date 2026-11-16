// Runs the mod in a real Vivaldi window against real tabs and a real web panel.
// Media is simulated: no audio URLs, decoders or real play() calls, so the test is silent.
// Silent pages never change their audible state, so the test sends audiostatechanged itself.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
    const binary = process.env.MEDIA_FOCUS_BROWSER || ['/opt/vivaldi-snapshot/vivaldi-bin', '/opt/vivaldi/vivaldi-bin'].find(fs.existsSync);
    if (!binary) { console.log('SKIP: Vivaldi is required.'); return; }
    const source = fs.readFileSync(path.join(__dirname, '../media-focus.js'), 'utf8');
    // "/spotify…" mimics Spotify: no media element in the DOM, a strict CSP, and play/pause
    // only through Media Session handlers. Like Spotify, the handlers are registered once the
    // player is set up, and playbackState stays 'none'. The DOM attribute is for the test only.
    const spotifyScript = `addEventListener('load', () => {
            const set = playing => { document.documentElement.dataset.playing = playing; };
            navigator.mediaSession.setActionHandler('play', () => set(true));
            navigator.mediaSession.setActionHandler('pause', () => set(false));
        });`;
    const server = http.createServer((request, response) => {
        if (request.url === '/spotify.js') {
            response.setHeader('Content-Type', 'text/javascript');
            response.end(spotifyScript);
        } else if (request.url.startsWith('/spotify')) {
            response.setHeader('Content-Type', 'text/html');
            response.setHeader('Content-Security-Policy', "script-src 'self'");
            response.end('<!doctype html><title>Spotify-like fixture</title><script src="/spotify.js"></script>');
        } else {
            response.setHeader('Content-Type', 'text/html');
            // The sandboxed iframe runs no scripts; executeScript reports it with result null.
            response.end('<!doctype html><title>Silent media fixture</title><audio id="audio"></audio>'
                + '<iframe sandbox srcdoc="<p>No scripts</p>"></iframe>');
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vivaldi-media-focus-test-'));
    const child = spawn(binary, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
    let ws;
    try {
        const endpoint = await new Promise((resolve, reject) => {
            let stderr = '';
            const timer = setTimeout(() => reject(Error('No DevTools endpoint: ' + stderr.slice(-1200))), 15000);
            child.stderr.on('data', data => {
                stderr += data;
                const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
                if (match) { clearTimeout(timer); resolve(match[1]); }
            });
            child.once('exit', code => { clearTimeout(timer); reject(Error('Browser exited ' + code + ': ' + stderr.slice(-1200))); });
        });
        ws = new WebSocket(endpoint);
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
        let sequence = 0;
        const pending = new Map();
        ws.onmessage = event => {
            const message = JSON.parse(event.data), request = pending.get(message.id);
            if (!request) return;
            pending.delete(message.id);
            message.error ? request.reject(Error(JSON.stringify(message.error))) : request.resolve(message.result);
        };
        const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
            const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
            pending.set(id, {resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); }});
            ws.send(JSON.stringify({id, method, params, sessionId}));
        });
        let ui;
        for (let i = 0; i < 80 && !ui; i++) {
            ui = (await call('Target.getTargets')).targetInfos.find(target => target.url.endsWith('/window.html'));
            if (!ui) await delay(100);
        }
        assert.ok(ui, 'Native Vivaldi UI');
        let {sessionId} = await call('Target.attachToTarget', {targetId: ui.targetId, flatten: true});
        const evaluate = async (expression, session = sessionId) => {
            const result = await call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, session)
                .catch(error => { throw Error(error.message + ' evaluating ' + expression.slice(0, 250)); });
            if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
            return result.result.value;
        };
        const until = async (expression, session = sessionId) => {
            for (let i = 0; i < 100; i++) {
                if (await evaluate(expression, session)) return;
                await delay(100);
            }
            throw Error('Timed out: ' + expression);
        };
        await until("!!document.getElementById('browser')");
        const bootUI = ui;
        const bootWindowId = await evaluate('vivaldiWindowId');
        await evaluate("chrome.storage.local.set({fullScreenModEnabled:false}).then(()=>chrome.windows.create({url:'about:blank'}))");
        for (let i = 0; i < 80; i++) {
            ui = (await call('Target.getTargets')).targetInfos.find(target => target.url.endsWith('/window.html') && target.targetId !== bootUI.targetId);
            if (ui) break;
            await delay(100);
        }
        assert.ok(ui, 'Fresh window with installed fullscreen mod disabled');
        ({sessionId} = await call('Target.attachToTarget', {targetId: ui.targetId, flatten: true}));
        await until("!!document.getElementById('browser') && !document.getElementById('app').classList.contains('fullscreen-listener-enabled')");
        await evaluate(`chrome.windows.remove(${bootWindowId})`);
        await evaluate("vivaldi.prefs.set({path:'vivaldi.tabs.auto_muting',value:'off'})");
        await evaluate(source);
        await evaluate(`(async()=>{window.__tabs={};for(const name of ['a','b','spotify']){__tabs[name]=(await chrome.tabs.create({url:${JSON.stringify(base)}+'/'+name,active:true})).id;await new Promise(resolve=>setTimeout(resolve,500));}})()`);
        await until('document.querySelectorAll("webview[tab_id]").length>=3');
        const run = (name, code) => evaluate(`new Promise(resolve=>document.querySelector('webview[tab_id="'+__tabs[${JSON.stringify(name)}]+'"]').executeScript({code:${JSON.stringify(code)}},results=>{void chrome.runtime.lastError;resolve(results?.[0]);}))`);
        // The mod inspects pages in their own (main) world, so the media stubs live there too.
        const main = (name, code) => evaluate(`chrome.scripting.executeScript({target:{tabId:__tabs[${JSON.stringify(name)}]},world:'MAIN',args:[${JSON.stringify(code)}],func:code=>(0,eval)(code)}).then(r=>r[0]?.result)`);
        const audioPaused = (name, value) => `chrome.scripting.executeScript({target:{tabId:__tabs.${name}},world:'MAIN',func:()=>document.querySelector('audio')?.paused}).then(r=>r[0]?.result===${value})`;
        const paused = name => audioPaused(name, true);
        const stub = `(() => {
            const media=document.querySelector('audio');
            media.__playing=false; media.__ended=false;
            Object.defineProperties(media,{
                paused:{get:()=>!media.__playing}, ended:{get:()=>media.__ended},
                currentTime:{get:()=>10}, readyState:{get:()=>4}
            });
            media.pause=()=>{media.__playing=false;media.dispatchEvent(new Event('pause'))};
            media.play=()=>{media.__ended=false;media.__playing=true;media.dispatchEvent(new Event('playing'));return Promise.resolve()};
            window.__end=()=>{media.__ended=true;media.__playing=false;media.dispatchEvent(new Event('ended'))};
        })()`;
        const emit = (name, audible=true) => evaluate(`(()=>{const event=new Event('audiostatechanged');event.audible=${audible};document.querySelector('webview[tab_id="'+__tabs.${name}+'"]').dispatchEvent(event)})()`);
        const play = async name => { await main(name, 'void document.querySelector("audio").play()'); await emit(name); };
        const playing = name => audioPaused(name, false);
        const session = (name, state) => `new Promise(resolve=>document.querySelector('webview[tab_id="'+__tabs.${name}+'"]').executeScript({code:'document.documentElement.dataset.playing'},r=>{void chrome.runtime.lastError;resolve(r?.[0]===${JSON.stringify(String(state === 'playing'))})}))`;
        const pause = async name => { await main(name, 'document.querySelector("audio").pause()'); await emit(name, false); };
        for (const name of ['a','b','spotify']) {
            await until(`(async()=> (await chrome.tabs.get(__tabs.${name})).status==='complete')()`);
            if (name !== 'spotify') await main(name, stub);
        }
        await play('a');
        await play('b');
        await until(paused('a'));
        await pause('b');
        await until(playing('a'));
        console.log('PASS B pauses A and pausing B resumes it');

        await play('b');
        await until(paused('a'));
        await main('b', '__end()');
        await emit('b', false);
        await until(playing('a'));
        console.log('PASS ended playback restores A');

        await play('b');
        await until(paused('a'));
        await emit('b', false); // Simulated silence while B remains in play state.
        await delay(500);
        assert.equal(await evaluate(paused('a')), true);
        await main('b', 'document.querySelector("audio").pause()'); // No further event, as in a real silent passage.
        await until(playing('a'));
        console.log('PASS silence keeps A paused; pausing during silence is noticed later');

        await play('b');
        await until(paused('a'));
        await evaluate('chrome.tabs.remove(__tabs.b)');
        await until(playing('a'));
        console.log('PASS closing B restores A');

        // Playback starts inside the page (the user presses play there).
        const startSession = async name => { await run(name, 'document.documentElement.dataset.playing=true'); await emit(name); };
        await pause('a');
        await startSession('spotify');
        await play('a');
        await until(session('spotify', 'paused'));
        await pause('a');
        await until(session('spotify', 'playing'));
        console.log('PASS Spotify-like player is paused and resumed through its Media Session handlers');

        await evaluate(`vivaldi.prefs.set({path:'vivaldi.panels.web.elements',value:[{id:'WEBPANEL_media-focus-test',url:${JSON.stringify(base)}+'/spotify-panel',activeUrl:${JSON.stringify(base)}+'/spotify-panel',title:'Media focus test',width:400,mobileMode:false,zoom:1,origin:'user',resizable:true,floating:false}]})`);
        await evaluate(`vivaldi.prefs.set({path:'vivaldi.toolbars.panel',value:['WEBPANEL_media-focus-test','PanelBookmarks']})`);
        await evaluate(`(()=>{
            const core=chrome.extension.getViews().find(view=>view.location.pathname==='/main.html');let require;
            core.webpackChunkgapp_browser_react.push([['media-focus-panel-test'],{},runtime=>require=runtime]);
            const id=Object.keys(require.m).find(id=>require.m[id].toString().includes('setMuted(e,t,n){'));
            const actions=Object.values(require(id)).find(value=>typeof value?.setMuted==='function');
            actions.setAddedButton(vivaldiWindowId,'vivaldi.toolbars.panel','WEBPANEL_media-focus-test',true);
            actions.showContent(vivaldiWindowId,'WEBPANEL_media-focus-test');
            actions.setContentVisible(vivaldiWindowId,true);
        })()`);
        await until("!!document.querySelector('webview[name=\"vivaldi-webpanel\"]')");
        await evaluate(`window.__tabs.panel=Number(document.querySelector('webview[name="vivaldi-webpanel"]').tab_id)`);
        await until(`(async()=> (await chrome.tabs.get(__tabs.panel)).status==='complete')()`);
        await startSession('panel');
        await until(session('spotify', 'paused'));
        console.log('PASS a Spotify-like web panel interrupts a tab');
        await play('a');
        await until(session('panel', 'paused'));
        await pause('a');
        await until(session('panel', 'playing'));
        console.log('PASS a Spotify-like web panel is paused and resumed like a tab');
        await evaluate('mediaFocus.destroy()');
    } finally {
        ws?.close();
        if (child.exitCode === null && child.signalCode === null) {
            child.kill();
            await new Promise(resolve => child.once('exit', resolve));
        }
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(profile, {recursive: true, force: true});
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
