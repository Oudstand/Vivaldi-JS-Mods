// Run with: node tests/dialog-gestures-browser.test.cjs
// Exercises the real native gesture dispatcher in an isolated profile.
// Gesture recognition is simulated at the native event boundary; effects use real dialog pages.
// DIALOG_READER_BROWSER and DIALOG_READER_CSS can override the binary and sibling CSS checkout.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const http = require('node:http');
(async () => {
 const browser=process.env.DIALOG_READER_BROWSER||['/opt/vivaldi-snapshot/vivaldi-bin','/opt/vivaldi/vivaldi-bin'].find(candidate=>fs.existsSync(candidate));
 const cssPath=process.env.DIALOG_READER_CSS||path.resolve(__dirname,'../../CSS/dialog.css');
 if(!browser||!fs.existsSync(cssPath)){console.log('SKIP native reader browser test: Vivaldi and dialog.css are required.');return;}
 const articleHTML='<!doctype html><title>Native reader test article</title><header id="original-navigation">Original site navigation</header><article><h1>Native reader test article</h1>'+Array.from({length:20},(_,i)=>'<p>Section '+i+': This is a detailed article about reading in a Vivaldi dialog. The native reader should extract the article content and preserve normal navigation through the existing related tab. Each paragraph explains the test clearly and provides enough text for article recognition.</p>').join('')+'</article>';
 const playerHTML='<!doctype html><body><video></video><script>window.addEventListener("message", async event => {if(event.data?.command === "enter") await document.body.requestFullscreen();});</script>';
 const server=http.createServer((request,response)=>{response.setHeader('Content-Type','text/html; charset=utf-8');response.end(request.url.startsWith('/player-frame')?playerHTML:articleHTML);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const articleURL='http://127.0.0.1:'+server.address().port+'/article';
 const css=fs.readFileSync(cssPath,'utf8');
 const source=fs.readFileSync(path.join(__dirname,'../dialog.js'),'utf8');
 const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vivaldi-reader-test-'));
 const child = spawn(browser, ['--lang=en-US','--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--disable-sync','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'], {stdio:['ignore','ignore','pipe']});
 let ws;
 try {
  const endpoint = await new Promise((resolve,reject) => {
   const timer=setTimeout(()=>reject(new Error('No DevTools endpoint')),15000);
   child.stderr.on('data',data=>{const match=data.toString().match(/DevTools listening on (ws:\/\/\S+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
   child.on('exit',code=>{clearTimeout(timer);reject(new Error('Browser exited '+code));});
  });
  ws = new WebSocket(endpoint);
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  let id=0;const pending=new Map();
  ws.onmessage=event=>{const msg=JSON.parse(event.data);if(!msg.id)return;const p=pending.get(msg.id);if(!p)return;pending.delete(msg.id);msg.error?p.reject(new Error(JSON.stringify(msg.error))):p.resolve(msg.result);};
  const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const request=++id;const timer=setTimeout(()=>{pending.delete(request);reject(new Error('CDP timeout '+method));},10000);pending.set(request,{resolve:r=>{clearTimeout(timer);resolve(r)},reject:e=>{clearTimeout(timer);reject(e)}});ws.send(JSON.stringify({id:request,method,params,sessionId}));});
  await new Promise(resolve=>setTimeout(resolve,1500));
  let targets=await call('Target.getTargets');
  const ui=targets.targetInfos.find(t=>t.url.endsWith('/window.html'));
  if(!ui) throw new Error('No Vivaldi window target');
  const {sessionId:uiSession}=await call('Target.attachToTarget',{targetId:ui.targetId,flatten:true});
  const evaluate=async(expression,sessionId=uiSession)=>{
   const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);
   if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));
   return result.result.value;
  };

  // The Vivaldi installation may load another copy of the mod through custom.js.
  // Give this fixture its own shared menu state so it always exercises the current checkout.
  const instrumented=source.replaceAll('dialog.mod.searchMenus','dialog.mod.searchMenus.test').replace('queueMicrotask(initDialog);','').replace(/\}\)\(\);\s*$/, 'window.__dialogClasses={DialogMod};})();');

  const coreTarget=(await call('Target.getTargets')).targetInfos.find(target=>target.url.endsWith('/main.html'));
  const {sessionId:coreSession}=await call('Target.attachToTarget',{targetId:coreTarget.targetId,flatten:true});
  await evaluate(`(()=>{
   let require;webpackChunkgapp_browser_react.push([['gesture-test-'+Math.random()],{},runtime=>require=runtime]);
   const id=Object.keys(require.m).find(id=>require.m[id].toString().includes('getCommandsForGestures(){'));
   window.__commands=Object.values(require(id)).find(value=>typeof value?.getCommandsForGestures==='function');
   window.__originalGestures=__commands.getCommandsForGestures;
   window.__originalActions=__commands.getCommands().map(command=>[command,command.action]);
   window.__listeners={};
   for(const name of ['onMouseGesture','onWebviewClickCheck']){
    const event=vivaldi.tabsPrivate[name],add=event.addListener;
    __listeners[name]=[];
    event.addListener=function(fn){__listeners[name].push(fn);return add.call(this,fn);};
   }
  })()`,coreSession);
  const testWindow=await evaluate(`(async()=>{
   await chrome.storage.local.set({fullScreenModEnabled:false});
   return (await chrome.windows.create({url:${JSON.stringify(articleURL)}+'?origin'})).id;
  })()`);
  let testUI;
  for(let i=0;i<80;i++){
   testUI=(await call('Target.getTargets')).targetInfos.find(target=>target.url.endsWith('/window.html')&&target.targetId!==ui.targetId);
   if(testUI)break;await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(testUI,'Missing gesture test window');
  const {sessionId:testSession}=await call('Target.attachToTarget',{targetId:testUI.targetId,flatten:true});
  const here=expression=>evaluate(expression,testSession);
  const wait=async expression=>{
   for(let i=0;i<80;i++){if(await here(expression))return;await new Promise(resolve=>setTimeout(resolve,100));}
   throw new Error('Timed out: '+expression);
  };
  await wait("!!document.querySelector('.webpageview webview')");
  await here(instrumented);
  await here(`(()=>{
   const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);
   window.__mod=new __dialogClasses.DialogMod();window.__originId=Number(__mod.getActiveWebview().tab_id);
  })()`);
  const open=async()=>{
   await here(`__mod.showDialog(${JSON.stringify(articleURL)},false)`);
   await wait("[...__mod.webviews.values()].at(-1)?.divContainer.isConnected");
   await here('void (window.__dialog=[...__mod.webviews.values()].at(-1))');
   await wait("(async()=> (await chrome.tabs.get(__dialog.relatedTabId)).status==='complete')()");
   await wait("__dialog.webview.checkVisibility({visibilityProperty:true})&&!__dialog.divContainer.querySelector('.dialog-tab').classList.contains('animating-open')");
  };
  const begin=async(inside=true)=>{
   const point=await here(`(()=>{const r=__dialog.webview.getBoundingClientRect();return ${inside?'{x:r.x+r.width/2,y:r.y+r.height/2}':'{x:r.x-10,y:r.y+r.height/2}'};})()`);
   await evaluate(`__listeners.onWebviewClickCheck.forEach(fn=>fn(${testWindow},true,2,${point.x},${point.y}))`,coreSession);
   return point;
  };
  let nextStroke=0;
  const bind=async name=>{
   const stroke='999'+nextStroke++;
   await evaluate(`__commands.dispatchAction({actionType:'COMMAND_UPDATE_COMMAND',item:{key:${JSON.stringify(name)},value:{...__commands.getCommandConfiguration(${JSON.stringify(name)}),gestures:[${JSON.stringify(stroke)}]}}})`,coreSession);
   return stroke;
  };
  const run=async(name,{inside=true,windowId=testWindow}={})=>{
   const stroke=await bind(name),point=await begin(inside);
   await evaluate(`__listeners.onMouseGesture.forEach(fn=>fn(${windowId},${point.x},${point.y},${JSON.stringify(stroke)}))`,coreSession);
  };
  const script=(webview,code)=>here(`new Promise(resolve=>${webview}.executeScript({code:${JSON.stringify(code)}},results=>resolve(results?.[0])))`);
  const originState=()=>here(`(async()=>({url:(await chrome.tabs.get(__originId)).url,y:await new Promise(resolve=>__mod.getActiveWebview().executeScript({code:'scrollY'},results=>resolve(results?.[0])))}))()`);
  await open();
  assert.equal(await evaluate(`__originalActions.every(([command,action])=>command.action===action)`,coreSession),true);
  console.log('PASS all native command actions remain untouched');
  const before=await originState();
  await script('__dialog.webview','history.pushState({},"","?gesture-history")');
  await run('COMMAND_PAGE_BACK',{windowId:testWindow+1000});
  assert.ok((await here('chrome.tabs.get(__dialog.relatedTabId)')).url.endsWith('?gesture-history'));
  await run('COMMAND_PAGE_BACK');
  await wait(`(async()=> (await chrome.tabs.get(__dialog.relatedTabId)).url===${JSON.stringify(articleURL)})()`);
  await run('COMMAND_PAGE_FORWARD');
  await wait("(async()=> (await chrome.tabs.get(__dialog.relatedTabId)).url.endsWith('?gesture-history'))()");
  assert.deepEqual(await originState(),before);
  console.log('PASS native Back/Forward gestures target the dialog and ignore other windows');

  await here("window.__loads=0;__dialog.webview.addEventListener('loadstart',()=>__loads++)");
  for(const command of ['COMMAND_PAGE_REFRESH','COMMAND_PAGE_RELOAD_NOCACHE']){
   const previousLoads=await here('__loads');
   await run(command);
   await wait(`__loads>${previousLoads}`);
   await wait("(async()=> (await chrome.tabs.get(__dialog.relatedTabId)).status==='complete')()");
  }
  assert.deepEqual(await originState(),before);
  console.log('PASS normal and cache-bypassing Reload target the dialog');

  const chainName='COMMAND_CHAIN_11223344-5566-7788-99aa-bbccddeeff00';
  await here(`vivaldi.prefs.set({path:'vivaldi.chained_commands.command_list',value:[{
   key:'11223344-5566-7788-99aa-bbccddeeff00',name:${JSON.stringify(chainName)},category:'CATEGORY_COMMAND_CHAIN',label:'Dialog history test',
   chain:[{key:'2eb81004-6703-46db-9933-6afcfde924e4',param:200},{key:'f8f93b48-b1ed-43c3-bd65-e7240fd76d3f'}]
  }]})`);
  await script('__mod.getActiveWebview()','history.pushState({},"","?chain-history")');
  await run(chainName);
  await wait(`(async()=> (await chrome.tabs.get(__originId)).url===${JSON.stringify(articleURL+'?origin')})()`);
  assert.ok((await here('chrome.tabs.get(__dialog.relatedTabId)')).url.endsWith('?gesture-history'));
  assert.deepEqual(await originState(),before);
  console.log('PASS chains started in the dialog keep their native main-tab behavior');

  // Ordinary shortcuts/actions and gestures started outside the dialog retain native behavior.
  await script('__mod.getActiveWebview()','history.pushState({},"","?origin-history")');
  await here(`(()=>{const core=chrome.extension.getViews().find(view=>view.location.href.endsWith('/main.html'));core.__commands.getCommands().find(command=>command.name==='COMMAND_PAGE_BACK').action({windowId:vivaldiWindowId,origin:'shortcut'});})()`);
  await wait(`(async()=> (await chrome.tabs.get(__originId)).url===${JSON.stringify(articleURL+'?origin')})()`);
  await script('__mod.getActiveWebview()','history.pushState({},"","?origin-history")');
  await run('COMMAND_PAGE_BACK',{inside:false});
  await wait(`(async()=> (await chrome.tabs.get(__originId)).url===${JSON.stringify(articleURL+'?origin')})()`);
  console.log('PASS ordinary native actions and outside gestures keep targeting the main tab');

  const outer=await here('__dialog.webview.id');
  const outerURL=await here('(async()=> (await chrome.tabs.get(__dialog.relatedTabId)).url)()');
  await open();
  const innerTab=await here('__dialog.relatedTabId');
  await script('__dialog.webview','history.pushState({},"","?nested-history")');
  await run('COMMAND_PAGE_BACK');
  await wait(`(async()=> (await chrome.tabs.get(${innerTab})).url===${JSON.stringify(articleURL)})()`);
  assert.equal(await here(`(async()=> (await chrome.tabs.get(__mod.webviews.get(${JSON.stringify(outer)}).relatedTabId)).url)()`),outerURL);
  await here('__mod.removeDialog(__dialog.webview.id)');
  await wait('__mod.webviews.size===1');
  assert.equal(await here(`(async()=>{try{await chrome.tabs.get(${innerTab});return false;}catch{return true;}})()`),true);
  assert.equal(await here('!!__mod.webviews.get('+JSON.stringify(outer)+')'),true);
  assert.deepEqual(await originState(),before);
  console.log('PASS navigation targets only the nested dialog under the pointer');

  await here('void (window.__dialog=[...__mod.webviews.values()][0])');
  await script('__dialog.webview','history.pushState({},"","?closing-history")');
  await script('__mod.getActiveWebview()','history.pushState({},"","?closing-guard")');
  const closingOrigin=await originState();
  const closingStroke=await bind('COMMAND_PAGE_BACK'),closingPoint=await begin();
  await here('__mod.removeDialog(__dialog.webview.id)');
  await evaluate(`__listeners.onMouseGesture.forEach(fn=>fn(${testWindow},${closingPoint.x},${closingPoint.y},${JSON.stringify(closingStroke)}))`,coreSession);
  await wait('__mod.webviews.size===0');
  assert.deepEqual(await originState(),closingOrigin);
  assert.equal(await evaluate(`!window[Symbol.for('dialog.mod.gestures')]&&__commands.getCommandsForGestures===__originalGestures&&__originalActions.every(([command,action])=>command.action===action)`,coreSession),true);
  console.log('PASS a gesture finishing during close preserves the origin; all native hooks are restored');
 } finally {
  ws?.close();child.kill('SIGTERM');server.close();
  await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},3000);child.on('exit',()=>{clearTimeout(timer);resolve();});});
  try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
 }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
