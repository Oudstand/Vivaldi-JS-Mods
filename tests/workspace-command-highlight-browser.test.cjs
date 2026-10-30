// Run with: node JS/tests/workspace-command-highlight-browser.test.cjs
// Uses temporary native Vivaldi profiles, real workspace actions and toolbar buttons.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const binary=process.env.WORKSPACE_HIGHLIGHT_BROWSER||['/opt/vivaldi-snapshot/vivaldi-bin','/opt/vivaldi/vivaldi-bin'].find(file=>fs.existsSync(file));
if(!binary)throw Error('Vivaldi is required');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vivaldi-workspace-highlight-test-'));
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
        let {sessionId}=await call('Target.attachToTarget',{targetId:testTarget.targetId,flatten:true});
        const evaluateHere=expression=>evaluate(expression,sessionId), wait=expression=>until(expression,sessionId);
        await wait("!!document.getElementById('browser')&&!!document.getElementById('webview-container')");
        await wait("!document.getElementById('app').classList.contains('fullscreen-listener-enabled')");
        const cssDir=path.resolve(__dirname,'../../CSS');
        for(const file of fs.readdirSync(cssDir).filter(f=>f.endsWith('.css')).sort())await evaluateHere(`(()=>{const style=document.createElement('style');style.dataset.reviewFile=${JSON.stringify(file)};style.textContent=${JSON.stringify(fs.readFileSync(path.join(cssDir,file),'utf8'))};document.head.append(style);})()`);
        await call('Emulation.setDeviceMetricsOverride',{width:1200,height:900,deviceScaleFactor:1,mobile:false},sessionId);

        const source=fs.readFileSync(path.resolve(__dirname,'../workspace-command-highlight.js'),'utf8');
        await evaluateHere(`(()=>{
            const core=chrome.extension.getViews().find(view=>view.location.href===chrome.runtime.getURL('main.html'));
            let require;core.webpackChunkgapp_browser_react.push([['workspace-highlight-test'],{},runtime=>{require=runtime}]);
            const find=(marker,method)=>{const id=Object.keys(require.m).find(id=>require.m[id].toString().includes(marker));return Object.values(require(id)).find(value=>typeof value?.[method]==='function')};
            window.__ws=find('getActiveWorkspaceId(e){','getActiveWorkspaceId');
            window.__wsActions=find('activateWorkspaceByIndex(e,t){','activateWorkspaceByIndex');
            window.__commands=find('getCommandsForGestures(){','getCommands');
            const icon=__ws.getDefaultIcon();
            for(const [id,name] of [[101,'Arbeit'],[102,'Freizeit'],[103,'Extra']])__wsActions.addWorkspaceWithId(id,name,icon);
        })()`);
        const pref=(path,value)=>evaluateHere(`vivaldi.prefs.set({path:${JSON.stringify(path)},value:${JSON.stringify(value)}})`);
        const guids=await evaluateHere("Object.fromEntries(__commands.getCommands().filter(c=>/^COMMAND_WORKSPACE_SWITCH_[1-4]$/.test(c.name)).map(c=>[c.name,c.guid]))");
        const chains=[['work',2],['play',3],['extra',4],['window',1]].map(([key,n])=>({key:'workspace-test-'+key,name:'COMMAND_workspace-test-'+key,label:'Shortcut '+key,category:'CATEGORY_COMMAND_CHAIN',chain:[{key:guids['COMMAND_WORKSPACE_SWITCH_'+n],name:'COMMAND_WORKSPACE_SWITCH_'+n}]}));
        await pref('vivaldi.chained_commands.command_list',chains);
        const toolbar=['COMMAND_workspace-test-work','COMMAND_workspace-test-play','COMMAND_workspace-test-extra','COMMAND_workspace-test-window','PanelBookmarks'];
        await pref('vivaldi.toolbars.panel',toolbar);
        await wait(`!!document.querySelector('#switch button[data-name="${toolbar[0]}"]')&&!!document.querySelector('#switch button[data-name="${toolbar[3]}"]')`);
        await evaluateHere(source);
        await wait("!!document.querySelector('#switch .workspace-command-active')");
        await evaluateHere(`(()=>{
            window.__originalWorkspaceRead=__ws.getActiveWorkspaceId;window.__workspaceReads=0;
            __ws.getActiveWorkspaceId=function(...args){__workspaceReads++;return __originalWorkspaceRead.apply(this,args)};
            const fixture=document.createElement('div');fixture.id='unrelated-dom';document.querySelector('#browser').append(fixture);
            for(let i=0;i<30;i++){const child=document.createElement('span');child.dataset.name='unrelated';fixture.append(child)}
            fixture.remove();
        })()`);
        await delay(150);
        const unrelatedReads=await evaluateHere("(()=>{__ws.getActiveWorkspaceId=__originalWorkspaceRead;return __workspaceReads})()");
        assert.equal(unrelatedReads,0,'Unrelated UI mutations must not read workspace state');
        console.log('PASS unrelated UI mutations do not trigger workspace recalculation');
        const active=()=>evaluateHere("[...document.querySelectorAll('#switch .workspace-command-active > button')].map(button=>button.dataset.name)");
        const switchTo=async index=>{
            await evaluateHere(`__wsActions.activateWorkspaceByIndex(vivaldiWindowId,${index===undefined?'undefined':index})`);
            const id=index===undefined?'undefined':[101,102,103][index];
            await wait(`__ws.getActiveWorkspaceId(vivaldiWindowId)===${id}`);await delay(400);
        };
        const theme=await evaluateHere("[...document.getElementById('browser').classList].find(name=>name.startsWith('theme-id-'))");
        for(const [index,expected] of [[0,toolbar[0]],[1,toolbar[1]],[2,toolbar[2]],[undefined,toolbar[3]]]){
            await switchTo(index);
            assert.deepEqual(await active(),[expected]);
            assert.equal(await evaluateHere("[...document.getElementById('browser').classList].find(name=>name.startsWith('theme-id-'))"),theme);
            const style=await evaluateHere(`(()=>{const el=document.querySelector('#switch .workspace-command-active'),button=el.firstElementChild,marker=getComputedStyle(button,'::before');return {opacity:getComputedStyle(el).opacity,background:getComputedStyle(button).backgroundColor,markerBackground:marker.backgroundColor,width:parseFloat(marker.width),height:parseFloat(marker.height),buttonWidth:button.getBoundingClientRect().width,buttonHeight:button.getBoundingClientRect().height,pointerEvents:marker.pointerEvents}})()`);
            assert.equal(style.opacity,'1');assert.equal(style.background,'rgba(0, 0, 0, 0)');
            assert.notEqual(style.markerBackground,'rgba(0, 0, 0, 0)');
            assert.equal(style.width,24);assert.equal(style.height,24);
            assert.ok(style.width<=style.buttonWidth-8&&style.height<=style.buttonHeight-8,'Marker must sit inside the full button hit area');
            assert.equal(style.pointerEvents,'none');
        }
        console.log('PASS actual workspace switches highlight command buttons without changing theme, including the default window');
        await switchTo(0);
        await evaluateHere("__wsActions.setName(101,'Renamed workspace')");await delay(100);
        assert.deepEqual(await active(),[toolbar[0]]);
        await evaluateHere("__wsActions.setOrder([102,101,103])");await delay(100);
        assert.deepEqual(await active(),[toolbar[1]]);
        await evaluateHere("__wsActions.setOrder([101,102,103])");await delay(100);
        assert.deepEqual(await active(),[toolbar[0]]);
        console.log('PASS workspace renaming and ordering follow native command targets');
        chains[0].chain=chains[1].chain;
        await pref('vivaldi.chained_commands.command_list',chains);await delay(250);
        assert.deepEqual(await active(),[]);
        await switchTo(1);assert.deepEqual((await active()).sort(),[toolbar[0],toolbar[1]].sort());
        console.log('PASS command chain edits update the target through native preference events');
        await evaluateHere(`document.querySelector('#switch button[data-name="${toolbar[0]}"]').dataset.name='PanelHistory'`);
        await delay(100);assert.deepEqual(await active(),[toolbar[1]]);
        await evaluateHere(`document.querySelector('#switch button[data-name="PanelHistory"]').dataset.name='${toolbar[0]}'`);
        await delay(100);assert.deepEqual((await active()).sort(),[toolbar[0],toolbar[1]].sort());
        console.log('PASS reused button nodes update their marker when the command changes');
        await pref('vivaldi.toolbars.panel',['PanelBookmarks']);await delay(200);
        assert.deepEqual(await active(),[]);
        await switchTo(0);
        assert.equal(await evaluateHere("document.querySelectorAll('#switch .workspace-command').length"),0);
        await switchTo(1);
        console.log('PASS a toolbar without workspace shortcuts remains unmarked');
        await pref('vivaldi.toolbars.panel',toolbar);await delay(250);
        assert.deepEqual((await active()).sort(),[toolbar[0],toolbar[1]].sort());
        assert.equal(await evaluateHere("document.querySelector('#switch button[data-name=PanelBookmarks]').parentElement.classList.contains('workspace-command')"),false);
        console.log('PASS rebuilt toolbar restores markers and leaves unrelated buttons alone');
        const beforeTargets=new Set((await call('Target.getTargets')).targetInfos.map(t=>t.targetId));
        const second=await evaluateHere("chrome.windows.create({url:'about:blank',type:'normal'})");
        let otherTarget;
        for(let i=0;i<80&&!otherTarget;i++){
            otherTarget=(await call('Target.getTargets')).targetInfos.find(t=>t.url.endsWith('/window.html')&&!beforeTargets.has(t.targetId));
            if(!otherTarget)await delay(100);
        }
        assert.ok(otherTarget,'Second native window must exist');
        const otherSession=(await call('Target.attachToTarget',{targetId:otherTarget.targetId,flatten:true})).sessionId;
        await until("!!document.querySelector('#switch button[data-name=\"COMMAND_workspace-test-extra\"]')",otherSession);
        await evaluate(source,otherSession);
        await evaluateHere(`__wsActions.activateWorkspaceByIndex(${second.id},2)`);
        await until("!!document.querySelector('#switch .workspace-command-active > button[data-name=\"COMMAND_workspace-test-extra\"]')",otherSession);
        assert.deepEqual((await active()).sort(),[toolbar[0],toolbar[1]].sort());
        await switchTo(0);assert.deepEqual(await active(),[]);
        assert.deepEqual(await evaluate("[...document.querySelectorAll('#switch .workspace-command-active > button')].map(b=>b.dataset.name)",otherSession),[toolbar[2]]);
        await evaluateHere(`chrome.windows.remove(${second.id})`);
        await switchTo(1);
        console.log('PASS two windows track their own active workspaces independently');
        await evaluateHere(source);await delay(150);
        assert.deepEqual((await active()).sort(),[toolbar[0],toolbar[1]].sort());
        await evaluateHere('window.workspaceCommandHighlight.destroy()');await delay(100);
        assert.deepEqual(await active(),[]);
        await evaluateHere("__wsActions.activateWorkspaceByIndex(vivaldiWindowId,0)");await delay(150);
        assert.deepEqual(await active(),[]);
        console.log('PASS reinjection and cleanup remove old listeners and markers');
    } finally {
        ws?.close();child.kill('SIGTERM');
        await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},2500);child.once('exit',()=>{clearTimeout(timer);resolve();});});
        fs.rmSync(profile,{recursive:true,force:true});
    }
})().catch(error=>{console.error(error);process.exitCode=1;});
