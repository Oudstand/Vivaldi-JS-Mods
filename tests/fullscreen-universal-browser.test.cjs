// Run with: node tests/fullscreen-universal-browser.test.cjs
// Uses an isolated Vivaldi profile, controlled layout fixtures and Vivaldi's native UI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, '../fullscreen-universal.js'), 'utf8');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
    const binary = process.env.FULLSCREEN_BROWSER || ['/opt/vivaldi-snapshot/vivaldi-bin', '/opt/vivaldi/vivaldi-bin'].find(file => fs.existsSync(file));
    if (!binary) {console.log('SKIP: Vivaldi is required.'); return;}
    async function run(native) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vivaldi-fullscreen-test-'));
    const child = spawn(binary, [...(native ? [] : ['--disable-vivaldi']),'--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--disable-sync','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'], {stdio:['ignore','ignore','pipe']});
    let ws;
    try {
        const endpoint = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('No DevTools endpoint')), 15000);
            child.stderr.on('data', data => {const match = data.toString().match(/DevTools listening on (ws:\/\/\S+)/); if (match) {clearTimeout(timer); resolve(match[1]);}});
            child.on('exit', code => {clearTimeout(timer); reject(Error('Browser exited: '+code));});
        });
        ws = new WebSocket(endpoint); await new Promise((resolve, reject) => {ws.onopen=resolve; ws.onerror=reject;});
        let sequence=0; const pending=new Map();
        ws.onmessage = event => {const msg=JSON.parse(event.data); if (!msg.id) return; const p=pending.get(msg.id); pending.delete(msg.id); if (p) msg.error ? p.reject(Error(JSON.stringify(msg.error))) : p.resolve(msg.result);};
        const call = (method, params={}, sessionId) => new Promise((resolve, reject) => {
            const id=++sequence, timer=setTimeout(() => {pending.delete(id); reject(Error('CDP timeout: '+method));}, 10000);
            pending.set(id, {resolve:r=>{clearTimeout(timer); resolve(r);}, reject:e=>{clearTimeout(timer); reject(e);}});
            ws.send(JSON.stringify({id, method, params, sessionId}));
        });
        const evaluate = async (expression, sessionId) => {
            const result=await call('Runtime.evaluate', {expression,awaitPromise:true,returnByValue:true,includeCommandLineAPI:true}, sessionId)
                .catch(error => {throw Error(error.message+' evaluating '+expression.slice(0,160));});
            if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
            return result.result.value;
        };
        const until = async (expression, sessionId) => {for (let i=0;i<80;i++) {const value=await evaluate(expression,sessionId); if (value) return value; await delay(100);} throw Error('Timed out: '+expression);};
        const instrument = options => {
            let text=source.replace('queueMicrotask(initFullscreen);', '');
            for (const [key,value] of Object.entries(options)) text=text.replace(new RegExp('('+key+' = )[^,;]+'), '$1'+value);
            return text.replace(/\}\)\(\);\s*$/, 'window.__FullscreenMod=FullscreenMod;})();');
        };
        await delay(1500);
        if (!native) {
        const initialTargets=await call('Target.getTargets');
        const {targetId}=initialTargets.targetInfos.find(target=>target.type==='page');
        const {sessionId:fixtureSession} = await call('Target.attachToTarget', {targetId,flatten:true});
        const fixture = async (options={}) => {
            await evaluate(`(()=>{
                window.__mod?.destroy();
                document.head.innerHTML='<style>*{box-sizing:border-box}body{margin:0}#browser{width:800px;height:600px}#header{height:32px}.mainbar{height:34px}.bookmark-bar{height:30px}#footer{height:20px}#tabs-tabbar-container{width:200px;height:500px}.tabbar-wrapper{width:200px;height:500px}#panels-container{width:40px;height:600px}#webview-container{height:300px}#app.fullscreen-listener-enabled #header,#app.fullscreen-listener-enabled .mainbar,#app.fullscreen-listener-enabled .bookmark-bar,#app.fullscreen-listener-enabled .tabbar-wrapper,#app.fullscreen-listener-enabled #panels-container,#app.fullscreen-listener-enabled #footer{transition:none!important}</style>';
                document.body.innerHTML='<div id="app"><div id="browser" class="address-top bookmark-bar-top"><header id="header"><div id="tabs-tabbar-container" class="left"><div class="tabbar-wrapper"></div></div></header><div class="mainbar"><div class="UrlBar-AddressField"><input id="urlFieldInput"></div></div><div class="bookmark-bar"></div><div id="panels-container" class="left"></div><div id="main"><div class="inner"><div id="webview-container"></div></div></div><footer id="footer"><span>Status</span></footer></div></div>';
                window.vivaldiWindowId=1;window.vivaldi={tabsPrivate:{onKeyboardShortcut:{addListener(){},removeListener(){}}}};
                chrome.storage={local:{get:async()=>({fullScreenModEnabled:true}),set:async()=>{}}};
                window.__observerErrors=[];window.onerror=message=>__observerErrors.push(message);
            })()`, fixtureSession);
            await evaluate(instrument(options), fixtureSession);
            await evaluate('void (window.__mod=new __FullscreenMod())', fixtureSession);
            await delay(350);
        };
        const f = expression => evaluate(expression, fixtureSession);
        await fixture();
        assert.equal(await f("getComputedStyle(__mod.tabBarWrapper).transform"), 'matrix(1, 0, 0, 1, -240, 0)');
        await f(`window.__left=__mod.hoverDivLeft;window.__style=__mod.styleEl;__mod.mainBar.style.height='74px';__mod.tabBarWrapper.style.width='320px';__mod.panelsContainer.style.width='50px'`);
        await until("__mod.app.style.getPropertyValue('--fs-top-offset')==='113px'&&__mod.app.style.getPropertyValue('--fs-left-offset')==='370px'", fixtureSession);
        assert.equal(await f("getComputedStyle(__mod.tabBarWrapper).transform"), 'matrix(1, 0, 0, 1, -370, 0)');
        assert.equal(await f('__left===__mod.hoverDivLeft&&__style===__mod.styleEl'), true);
        console.log('PASS real ResizeObserver updates offsets and transforms without recreating hover areas');
        await f("__mod.panelsContainer.classList.replace('left','right');__mod.tabBarContainer.classList.replace('left','right');__mod.browser.classList.remove('address-top','bookmark-bar-top')");
        await until('!__mod.hoverDivLeft&&!!__mod.hoverDivRight', fixtureSession);
        assert.equal(await f("__mod.app.style.getPropertyValue('--fs-right-offset')"), '370px');
        await f('__mod.hide()'); await delay(300);
        assert.equal(await f('getComputedStyle(__mod.mainBar).opacity'), '0');
        await f("document.querySelector('#urlFieldInput').focus()");
        assert.equal(await f('getComputedStyle(__mod.mainBar).opacity'), '1');
        assert.equal(await f('Math.abs(document.querySelector(".UrlBar-AddressField").getBoundingClientRect().width-innerWidth/2)<1'), true);
        console.log('PASS positions and focused address fields update automatically for bottom and right layouts');
        await f(`(()=>{const old=__mod.mainBar;const bar=old.cloneNode(true);bar.style.height='94px';old.replaceWith(bar);window.__oldBar=old;})()`);
        await until("__mod.app.style.getPropertyValue('--fs-main-bar-height')==='94px'", fixtureSession);
        assert.equal(await f('__mod.observedElements.has(__oldBar)'), false);
        console.log('PASS replacement toolbar elements are measured and old elements are released');
        await fixture({hideTabs:false,hidePanels:false});
        assert.equal(await f("document.querySelector('.hover-div.left,.hover-div.right')"), null);
        assert.equal(await f("document.elementFromPoint(2,200)?.classList.contains('hover-div')"), false);
        console.log('PASS disabled sidebar hiding leaves no invisible edge blockers');
        await fixture({useTwoLevelTabStack:true,updateHoverDivSize:true});
        await f("__mod.browser.classList.add('maximized')");
        await until("__mod.hoverDivTop.style.height==='1px'", fixtureSession);
        await f(`for(let i=0;i<3;i++){__mod.toggleFullScreen();__mod.toggleFullScreen();}__mod.hide();__mod.toggleFullScreen()`);
        await delay(400);
        assert.equal(await f('__mod.app.className'), '');
        assert.equal(await f("(getEventListeners(__mod.webView).pointerenter||[]).length"), 0);
        assert.equal(await f("(getEventListeners(window).resize||[]).length"), 0);
        await f("__mod.webView.dispatchEvent(new Event('pointerenter'));window.dispatchEvent(new Event('resize'))"); await delay(300);
        assert.equal(await f('__mod.app.className'), '');
        assert.deepEqual(await f('__observerErrors'), []);
        console.log('PASS repeated toggles cancel native DOM listeners, pending timers and hover-size updates');
        return;
        }
        const targets=await call('Target.getTargets'); const ui=targets.targetInfos.find(target=>target.url.endsWith('/window.html'));
        assert.ok(ui,'Vivaldi native window target');
        const {sessionId:uiSession}=await call('Target.attachToTarget',{targetId:ui.targetId,flatten:true});
        await until("!!document.getElementById('webview-container')&&!!document.getElementById('browser')",uiSession);
        await delay(500);
        // custom.js can load an older mod. Isolate the checkout in this temporary UI.
        await evaluate(`(()=>{
            const content=document.getElementById('webview-container');
            for(const type of ['pointerenter','pointerleave']) {
                for(const entry of getEventListeners(content)[type]||[]) {
                    if(['bound hide','bound clearHideTimeout'].includes(entry.listener.name)) content.removeEventListener(type,entry.listener,entry.useCapture);
                }
            }
            document.querySelectorAll('.hover-div').forEach(element=>element.remove());
            document.querySelectorAll('style').forEach(style=>{if(style.textContent.includes('#app:not(.fullscreen-listener-enabled) .hover-div'))style.remove();});
            document.getElementById('app').classList.remove('fullscreen-listener-enabled','hidden-top','hidden-bottom','hidden-left','hidden-right');
        })()`,uiSession);
        await evaluate(instrument({}),uiSession);
        await evaluate('void (window.__mod=new __FullscreenMod())',uiSession);
        await until("document.getElementById('app').classList.contains('fullscreen-listener-enabled')",uiSession);
        await delay(350);
        assert.equal(await evaluate("(getEventListeners(__mod.webView).pointerenter||[]).length",uiSession),1);
        const initialHeight=await evaluate('__mod.mainBar.offsetHeight',uiSession);
        await evaluate(`__mod.mainBar.style.cssText+=';height:${initialHeight+20}px!important;min-height:${initialHeight+20}px!important;max-height:none!important'`,uiSession);
        await until(`__mod.app.style.getPropertyValue('--fs-main-bar-height')==='${initialHeight+20}px'`,uiSession);
        const savedBeforeEditing=await evaluate("(async()=>JSON.stringify(await chrome.storage.local.get('fullScreenModEnabled')))()",uiSession);
        await evaluate("__mod.hide();__mod.browser.classList.add('toolbar-edit-mode')",uiSession);
        await until("!__mod.listenerController&&!__mod.app.classList.contains('fullscreen-listener-enabled')",uiSession);
        await delay(300);
        assert.equal(await evaluate('__mod.fullscreenEnabled&&!__mod.hoverDivTop&&!__mod.app.className.includes("hidden-")',uiSession),true);
        assert.equal(await evaluate('getComputedStyle(__mod.mainBar).opacity',uiSession),'1');
        assert.equal(await evaluate("(async()=>JSON.stringify(await chrome.storage.local.get('fullScreenModEnabled')))()",uiSession),savedBeforeEditing);
        await evaluate("__mod.browser.classList.remove('toolbar-edit-mode')",uiSession);
        await until("!!__mod.listenerController&&__mod.app.classList.contains('fullscreen-listener-enabled')",uiSession);
        assert.equal(await evaluate("(getEventListeners(__mod.webView).pointerenter||[]).length",uiSession),1);
        console.log('PASS toolbar editing pauses auto-hide, preserves the saved preference and resumes once');
        await evaluate(`for(let i=0;i<3;i++){__mod.handlers.shortcut(vivaldiWindowId,'F11');__mod.handlers.shortcut(vivaldiWindowId,'F11');}__mod.handlers.shortcut(vivaldiWindowId,'F11')`,uiSession);
        await delay(350);
        assert.equal(await evaluate("(getEventListeners(__mod.webView).pointerenter||[]).length",uiSession),0);
        assert.equal(await evaluate("__mod.app.className.includes('hidden-')",uiSession),false);
        await evaluate('__mod.destroy()',uiSession);
        console.log('PASS native Vivaldi UI, storage, F11 routing, resize measurement and repeated shutdown');
    } finally {
        ws?.close(); child.kill('SIGTERM');
        await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},2500);child.once('exit',()=>{clearTimeout(timer);resolve();});});
        fs.rmSync(profile,{recursive:true,force:true});
    }
    }
    await run(false);
    await run(true);
})().catch(error=>{console.error(error);process.exitCode=1;});
