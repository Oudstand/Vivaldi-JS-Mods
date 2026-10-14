// Run with: node tests/automate-bookmark-bar-browser.test.cjs
// Uses an isolated native Vivaldi profile and all sibling CSS mods.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, '../automate-bookmark-bar.js'), 'utf8');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const http=require('node:http');
(async () => {
    const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(req.url.startsWith('/iframe')?'<iframe style="position:fixed;inset:0;width:100vw;height:100vh;border:0" src="http://localhost:'+server.address().port+'/frame"></iframe>':'<!doctype html><title>Bookmark test article</title><button style="position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);padding:30px" onclick="document.body.dataset.clicked=\'yes\'">Article action</button>');});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const articleURL='http://127.0.0.1:'+server.address().port+'/article';
    const binary = process.env.BOOKMARK_BAR_BROWSER || ['/opt/vivaldi-snapshot/vivaldi-bin', '/opt/vivaldi/vivaldi-bin'].find(file => fs.existsSync(file));
    if (!binary) {server.close(); console.log('SKIP: Vivaldi is required.'); return;}
    async function run() {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vivaldi-bookmarks-test-'));
    const child = spawn(binary, ['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--disable-sync','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'], {stdio:['ignore','ignore','pipe']});
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
        const targets=await call('Target.getTargets'),target=targets.targetInfos.find(t=>t.url.endsWith('/window.html'));
        const initial=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true});
        await evaluate("chrome.storage.local.set({fullScreenModEnabled:false}).then(()=>chrome.windows.create({url:'about:blank',type:'normal'}))",initial.sessionId);
        let testTarget;
        for(let i=0;i<80&&!testTarget;i++){
            testTarget=(await call('Target.getTargets')).targetInfos.find(t=>t.url.endsWith('/window.html')&&t.targetId!==target.targetId);
            if(!testTarget)await delay(100);
        }
        assert.ok(testTarget,'A fresh native window is required to disable the installed fullscreen mod');
        const {sessionId}=await call('Target.attachToTarget',{targetId:testTarget.targetId,flatten:true});
        const evaluateHere=expression=>evaluate(expression,sessionId), wait=expression=>until(expression,sessionId);
        await wait("!!document.getElementById('browser')&&!!document.getElementById('webview-container')");
        await wait("!document.getElementById('app').classList.contains('fullscreen-listener-enabled')");
        await evaluateHere(`(async()=>{
            await vivaldi.prefs.set({path:'vivaldi.bookmarks.bar.visible',value:true});
            await vivaldi.prefs.set({path:'vivaldi.bookmarks.bar.position',value:'top'});
            const barFolder=await chrome.bookmarks.create({parentId:'1',title:'Test bookmark bar'});await chrome.bookmarks.update(barFolder.id,{bookmarkbar:true});
            const bookmark=await chrome.bookmarks.create({parentId:barFolder.id,index:0,title:'Test bookmark',url:${JSON.stringify(articleURL)}});window.__bookmark=bookmark.id;
            const folder=await chrome.bookmarks.create({parentId:barFolder.id,index:1,title:'Test folder'});window.__folder=folder.id;
            await chrome.bookmarks.create({parentId:folder.id,title:'Child bookmark',url:${JSON.stringify(articleURL)}});
            const tab=await chrome.tabs.create({windowId:vivaldiWindowId,url:${JSON.stringify(articleURL)},active:true});window.__tabId=tab.id;
        })()`);
        await wait(`!!document.querySelector('.bookmark-bar button[data-id="'+__bookmark+'"]')`);
        await evaluateHere(`(()=>{
            document.getElementById('app').classList.remove('fullscreen-listener-enabled','hidden-top','hidden-bottom','hidden-left','hidden-right');
            document.querySelectorAll('.hover-div').forEach(el=>el.remove());
            let marker=document.getElementById('switch');if(!marker){marker=document.createElement('div');marker.id='switch';document.getElementById('browser').append(marker);}
            const button=document.createElement('button');button.title='automate-bookmark-bar';marker.append(button);
        })()`);
        const cssDir=path.resolve(__dirname,'../../CSS');
        for(const file of fs.readdirSync(cssDir).filter(file=>file.endsWith('.css')).sort())await evaluateHere(`(()=>{const style=document.createElement('style');style.textContent=${JSON.stringify(fs.readFileSync(path.join(cssDir,file),'utf8'))};document.head.append(style);})()`);
        await evaluateHere(source);
        const opacity=()=>evaluateHere("getComputedStyle(document.querySelector('.bookmark-bar')).opacity");
        const move=point=>call('Input.dispatchMouseEvent',{type:'mouseMoved',...point},sessionId);
        const click=async point=>{await move(point);await call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point},sessionId);await call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point},sessionId);};
        const contentPoint=()=>evaluateHere(`(()=>{const r=document.getElementById('webview-container').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
        const open=async()=>{
            const strip=await evaluateHere(`(()=>{const r=document.querySelector('.bookmark-bar').getBoundingClientRect();return {x:r.x+80,y:r.bottom-2};})()`);
            await move(strip);await wait("getComputedStyle(document.querySelector('.bookmark-bar')).opacity==='1'");await delay(120);
        };
        const hide=async()=>{await move(await contentPoint());try{await wait("getComputedStyle(document.querySelector('.bookmark-bar')).opacity==='0'");}catch(error){console.log('HIDE_DIAGNOSTICS',await evaluateHere(`({bar:document.querySelector('.bookmark-bar').outerHTML.slice(0,200),sensor:document.querySelector('.bookmark-bar-page-sensor')?.outerHTML,hit:document.elementFromPoint(400,300)?.outerHTML.slice(0,150)})`));throw error;}};
        await hide();await open();await hide();await open();await hide();
        console.log('PASS repeated hover-to-page transitions hide the bar and allow re-entry');
        await open();await click(await contentPoint());
        assert.equal(await evaluateHere(`new Promise(resolve=>document.querySelector('.webpageview.active.visible webview').executeScript({code:'document.body.dataset.clicked'},results=>resolve(results[0])))`),'yes');
        await hide();
        console.log('PASS the first click after leaving the bar reaches the webpage');
        await open();
        const folderPoint=await evaluateHere(`(()=>{const r=document.querySelector('.bookmark-bar button[data-id="'+__folder+'"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
        await click(folderPoint);await click(await contentPoint());await hide();
        console.log('PASS clicking a native bookmark folder and returning to the page hides the bar');
        await open();
        const bookmarkPoint=await evaluateHere(`(()=>{const r=document.querySelector('.bookmark-bar button[data-id="'+__bookmark+'"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
        await click(bookmarkPoint);await wait("(async()=>(await chrome.tabs.get(__tabId)).status==='complete')()");await hide();
        console.log('PASS clicking a native bookmark and entering the loaded page hides the bar');
        await evaluateHere(`chrome.tabs.update(__tabId,{url:${JSON.stringify(new URL('/iframe',articleURL).href)}})`);
        await wait("(async()=>(await chrome.tabs.get(__tabId)).status==='complete')()");await open();
        await hide();
        console.log('PASS entering a cross-origin iframe hides the bar');
        await evaluateHere("chrome.tabs.update(__tabId,{url:'vivaldi://startpage/'})");
        await wait("(async()=>(await chrome.tabs.get(__tabId)).status==='complete')()");await delay(200);
        await open();await hide();console.log('PASS the native start page still hides the bar');
        await evaluateHere(`chrome.tabs.update(__tabId,{url:${JSON.stringify(articleURL)}})`);
        await wait("(async()=>(await chrome.tabs.get(__tabId)).status==='complete')()");
        await open();await evaluateHere("document.getElementById('urlFieldInput').focus()");
        await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,nativeVirtualKeyCode:9},sessionId);
        await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,nativeVirtualKeyCode:9},sessionId);
        await evaluateHere(`document.querySelector('.bookmark-bar button[data-id="'+__bookmark+'"]').focus()`);
        assert.equal(await evaluateHere("document.querySelector('.bookmark-bar').matches(':has(:focus-visible)')"),true);
        await move(await contentPoint());await delay(1300);assert.equal(await opacity(),'1');
        await evaluateHere('document.activeElement.blur()');await wait("getComputedStyle(document.querySelector('.bookmark-bar')).opacity==='0'");
        console.log('PASS keyboard focus keeps the bar visible until focus leaves it');
        await evaluateHere("document.getElementById('browser').classList.add('toolbar-edit-mode')");
        await wait("getComputedStyle(document.querySelector('.bookmark-bar')).opacity==='1'");
        assert.notEqual(await evaluateHere("getComputedStyle(document.querySelector('.bookmark-bar')).marginBottom"),'-36px');
        await evaluateHere("document.getElementById('browser').classList.remove('toolbar-edit-mode')");
        assert.notEqual(await evaluateHere("(()=>{document.getElementById('app').classList.add('fullscreen-listener-enabled');return getComputedStyle(document.querySelector('.bookmark-bar')).marginBottom;})()"),'-36px');
        await evaluateHere("document.getElementById('app').classList.remove('fullscreen-listener-enabled')");
        console.log('PASS toolbar editing and the fullscreen mod retain their own layout');
        await open();await hide();
        assert.equal(await evaluateHere("!!document.querySelector('.bookmark-bar-page-sensor')"),false);
        console.log('PASS the temporary UI surface is removed after entering the page');
    }finally{
        ws?.close();child.kill('SIGTERM');
        await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},2500);child.once('exit',()=>{clearTimeout(timer);resolve();});});
        fs.rmSync(profile,{recursive:true,force:true});
    }
    }
    try{await run();}finally{server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
