// Run with: node tests/domain-title-bar-browser.test.cjs
// Uses isolated Vivaldi profiles, controlled DOM fixtures and native tab events.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, '../domain-title-bar.js'), 'utf8');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const http=require('node:http');
(async () => {
    const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>'+(req.url.startsWith('/second')?'Second article':'Domain test article')+'</title><p>Domain test</p>');});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const articleURL='http://127.0.0.1:'+server.address().port+'/article';
    const binary = process.env.DOMAIN_TITLE_BROWSER || ['/opt/vivaldi-snapshot/vivaldi-bin', '/opt/vivaldi/vivaldi-bin'].find(file => fs.existsSync(file));
    if (!binary) {server.close(); console.log('SKIP: Vivaldi is required.'); return;}
    async function run(native) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vivaldi-domain-test-'));
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
        await delay(1500);
        const targets=await call('Target.getTargets');
        const target=targets.targetInfos.find(t=>native?t.url.endsWith('/window.html'):t.type==='page');
        const {sessionId}=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true});
        const evaluateHere=expression=>evaluate(expression,sessionId);
        const wait=expression=>until(expression,sessionId);
        const snapshot=()=>evaluateHere(`({domain:document.querySelector('.DomainText')?.textContent,title:document.querySelector('.PageTitle')?.textContent,disabled:document.querySelector('.DomainButton')?.disabled})`);
        if(!native){
            await evaluateHere(`(()=>{
                document.head.innerHTML='<title>Unrelated window title</title>';
                document.body.innerHTML='<div id="browser"><div class="UrlBar-AddressField"><div class="UrlBar-UrlFieldWrapper"><input id="urlFieldInput" value="http://wrong.test/"><div class="UrlFragments"><div class="UrlFragment-Wrapper"><span class="UrlFragment-Link">wrong.test</span></div></div></div></div></div>';
                window.vivaldiWindowId=1;window.__updates=[];window.__frames=0;
                const raf=window.requestAnimationFrame;window.requestAnimationFrame=fn=>{__frames++;return raf.call(window,fn);};
                window.__events={};for(const name of ['onActivated','onUpdated','onRemoved','onReplaced']){const listeners=new Set();__events[name]={addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn),emit:(...args)=>listeners.forEach(fn=>fn(...args)),listeners};}
                window.__tab={id:1,windowId:1,active:true,url:'http://www.example.test:8123/article',title:'Native article'};
                chrome.tabs={...__events,query:async()=>[__tab],get:async()=>__tab,update:async(id,options)=>__updates.push({id,...options})};
                chrome.management={get:async()=>({name:'Test extension'})};
            })()`);
            await evaluateHere(source);
            await wait("document.querySelector('.PageTitle')?.textContent==='Native article'");
            assert.deepEqual(await snapshot(),{domain:'example.test:8123',title:'Native article',disabled:false});
            await evaluateHere("document.querySelector('.DomainButton').click()");
            assert.deepEqual(await evaluateHere('__updates'),[{id:1,url:'http://www.example.test:8123/'}]);
            await evaluateHere(`__tab={...__tab,url:'https://changed.test/spa',title:'SPA title'};__events.onUpdated.emit(1,{url:__tab.url,title:__tab.title},__tab)`);
            await wait("document.querySelector('.DomainText')?.textContent==='changed.test'");
            assert.equal((await snapshot()).title,'SPA title');
            assert.equal(await evaluateHere("document.getElementById('urlFieldInput').getAttribute('value')"),'http://wrong.test/');
            console.log('PASS canonical tab URLs and titles override stale rendered URL fragments and input attributes');
            await evaluateHere(`(()=>{const field=document.querySelector('.UrlBar-AddressField');field.replaceWith(field.cloneNode(true));})()`);
            await delay(100);await evaluateHere("document.querySelector('.DomainButton').click()");
            assert.deepEqual((await evaluateHere('__updates')).at(-1),{id:1,url:'https://changed.test/'});
            assert.equal(await evaluateHere("document.querySelectorAll('.DomainButton').length"),1);
            await evaluateHere("document.querySelector('.PageTitle').remove()");await wait("document.querySelector('.PageTitle')?.textContent==='SPA title'");
            await evaluateHere("document.querySelector('.UrlFragment-Wrapper').remove()");await delay(100);
            const frames=await evaluateHere('__frames');await delay(250);assert.equal(await evaluateHere('__frames'),frames);
            await evaluateHere(`(()=>{const wrapper=document.createElement('div');wrapper.className='UrlFragment-Wrapper';document.querySelector('.UrlBar-UrlFieldWrapper').append(wrapper);})()`);
            await wait("document.querySelector('.PageTitle')?.textContent==='SPA title'");
            console.log('PASS toolbar clones and removed titles recover without class changes, duplicate handlers or polling');
            await evaluateHere(`(()=>{const warning=document.createElement('span');warning.className='UrlBar-UrlObfuscationWarning';warning.textContent='Native warning';document.querySelector('.UrlBar-AddressField').append(warning);})()`);
            assert.notEqual(await evaluateHere("getComputedStyle(document.querySelector('.UrlBar-UrlObfuscationWarning')).display"),'none');
            console.log('PASS the native domain visibility warning is not hidden');
            await evaluateHere(`__tab={...__tab,url:'file:///tmp/article.html',title:'Local article'};__events.onUpdated.emit(1,{url:__tab.url,title:__tab.title},__tab)`);
            await wait("document.querySelector('.DomainButton')?.disabled");assert.equal((await snapshot()).domain,'file');
            await evaluateHere('window.domainTitleBar.destroy()');
            assert.equal(await evaluateHere("document.querySelectorAll('.DomainButton,.PageTitle').length"),0);
            assert.equal(await evaluateHere('Object.values(__events).every(event=>event.listeners.size===0)'),true);
            console.log('PASS unsupported navigation is disabled and cleanup removes native listeners and owned DOM');
        }else{
            await wait("!!document.getElementById('urlFieldInput')");
            await evaluateHere(`(()=>{
                window.domainTitleBar?.destroy?.();
                for(const name of ['uiObserver','urlFieldMutationObserver','titleMutationObserver'])window.domainTitleBar?.[name]?.disconnect();
                document.querySelectorAll('.DomainButton,.PageTitle').forEach(el=>el.remove());
                document.querySelectorAll('style').forEach(style=>{if(style.textContent.includes('.DomainText:hover:hover'))style.remove();});
            })()`);
            await evaluateHere(source);
            await evaluateHere(`(async()=>{const tab=await chrome.tabs.create({windowId:vivaldiWindowId,active:true,url:${JSON.stringify(articleURL)}});window.__tabId=tab.id;})()`);
            await wait("document.querySelector('.PageTitle')?.textContent==='Domain test article'");
            const expectedHost=new URL(articleURL).host;
            assert.equal((await snapshot()).domain,expectedHost);
            await evaluateHere("document.querySelector('.DomainButton').click()");
            await wait(`(async()=>{const tab=await chrome.tabs.get(__tabId);return tab.status==='complete'&&tab.url===${JSON.stringify(new URL(articleURL).origin+'/')};})()`);
            assert.equal((await snapshot()).domain,expectedHost);
            console.log('PASS native HTTP domain clicks keep the protocol and port and reach the homepage');
            await evaluateHere(`chrome.scripting.executeScript({target:{tabId:__tabId},world:'MAIN',func:()=>{history.pushState({},'', '/spa');document.title='Native SPA title';}})`);
            await wait("document.querySelector('.PageTitle')?.textContent==='Native SPA title'");
            assert.equal((await snapshot()).domain,expectedHost);
            console.log('PASS native SPA and title events update the address bar');
            await evaluateHere("document.getElementById('app').classList.remove('fullscreen-listener-enabled','hidden-top');document.querySelector('.webpageview.active.visible webview').focus()");
            await wait("document.querySelector('.UrlBar-UrlFieldWrapper').title==='Native SPA title'");
            const tooltipPoint=await evaluateHere(`(()=>{const rect=document.querySelector('.PageTitle').getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};})()`);
            await call('Input.dispatchMouseEvent',{type:'mouseMoved',...tooltipPoint},sessionId);
            assert.deepEqual(await evaluateHere(`(()=>{const title=document.querySelector('.PageTitle'),rect=title.getBoundingClientRect();const hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);let owner=hit;while(owner&&!owner.hasAttribute('title'))owner=owner.parentElement;return {hit:hit.id,tooltip:owner?.title,pointerEvents:getComputedStyle(title).pointerEvents};})()`),{hit:'urlFieldInput',tooltip:'Native SPA title',pointerEvents:'none'});
            await call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...tooltipPoint},sessionId);
            await call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...tooltipPoint},sessionId);
            assert.equal(await evaluateHere("document.activeElement.id"),'urlFieldInput');
            assert.equal(await evaluateHere("document.querySelector('.UrlBar-UrlFieldWrapper').getAttribute('title')"),null);
            await evaluateHere("document.querySelector('.webpageview.active.visible webview').focus()");
            await wait("document.querySelector('.UrlBar-UrlFieldWrapper').title==='Native SPA title'");
            console.log('PASS native input hover inherits the full title and clicking still focuses the address field');
            await evaluateHere(`(async()=>{const tab=await chrome.tabs.create({windowId:vivaldiWindowId,active:false,url:${JSON.stringify(new URL('/second',articleURL).href)}});window.__secondId=tab.id;})()`);
            await wait("(async()=>{const tab=await chrome.tabs.get(__secondId);return tab.status==='complete';})()");
            assert.equal((await snapshot()).title,'Native SPA title');
            await evaluateHere('chrome.tabs.update(__secondId,{active:true})');await wait("document.querySelector('.PageTitle')?.textContent==='Second article'");
            await evaluateHere('chrome.tabs.remove(__secondId)');await wait("document.querySelector('.PageTitle')?.textContent==='Native SPA title'");
            console.log('PASS background tabs, tab switching and closing the active tab keep the metadata in sync');
            await evaluateHere("chrome.tabs.update(__tabId,{url:'vivaldi://settings/'})");
            await wait("document.querySelector('.DomainText')?.textContent==='vivaldi:settings'");
            await evaluateHere("document.querySelector('.DomainButton').click()");await delay(500);
            assert.equal((await snapshot()).domain,'vivaldi:settings');
            assert.notEqual(await evaluateHere("(async()=>(await chrome.tabs.get(__tabId)).url)()"),'about:blank');
            await evaluateHere("chrome.tabs.update(__tabId,{url:'vivaldi://startpage/'})");await wait("document.querySelector('.DomainText')?.textContent==='vivaldi:startpage'");
            console.log('PASS internal Vivaldi settings and start-page URLs are recognized without converting to HTTPS');
            await evaluateHere(`(async()=>{const win=await chrome.windows.get(vivaldiWindowId);window.__oldWindowState=win.state;await chrome.windows.update(vivaldiWindowId,{state:'fullscreen'});})()`);
            await delay(200);
            await evaluateHere("chrome.windows.update(vivaldiWindowId,{state:__oldWindowState})");
            await wait("document.querySelector('.DomainText')?.textContent==='vivaldi:startpage'");
            assert.equal(await evaluateHere("document.querySelectorAll('.DomainButton').length"),1);
            console.log('PASS the native fullscreen transition restores a single domain display');
            await evaluateHere('window.domainTitleBar.destroy()');
        }
    } finally {
        ws?.close();child.kill('SIGTERM');
        await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},2500);child.once('exit',()=>{clearTimeout(timer);resolve();});});
        fs.rmSync(profile,{recursive:true,force:true});
    }
    }
    try{await run(false);await run(true);}finally{server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
