// Run with: node tests/dialog-integration-browser.test.cjs
// Uses Vivaldi's real UI and an isolated temporary profile, never the user's browser profile.
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

  const until=async(expression)=>{for(let i=0;i<80;i++){const value=await evaluate(expression);if(value)return value;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Timed out: '+expression);};
  // The Vivaldi installation may load another copy of the mod through custom.js.
  // Give this fixture its own shared menu state so it always exercises the current checkout.
  const instrumented=source.replaceAll('dialog.mod.searchMenus','dialog.mod.searchMenus.test').replace('queueMicrotask(initDialog);','').replace(/\}\)\(\);\s*$/, 'window.__dialogClasses={DialogMod};})();');
  await evaluate(instrumented);
  await evaluate(`(()=>{
   const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);
   const core=chrome.extension.getViews().find(view=>view.location.href===chrome.runtime.getURL('main.html'));
   const add=core.chrome.contextMenus.onClicked.addListener;
   core.chrome.contextMenus.onClicked.addListener=handler=>{core.__dialogMenuHandler=handler;add.call(core.chrome.contextMenus.onClicked,handler);};
   try{window.__mod=new __dialogClasses.DialogMod();}finally{core.chrome.contextMenus.onClicked.addListener=add;}
  })()`);
  await evaluate('__mod.searchEngineUtils.ready');
  assert.equal(await evaluate(`(()=>{let calls=0;const old=__mod.KEYBOARD_SHORTCUTS.Esc;__mod.KEYBOARD_SHORTCUTS.Esc=()=>calls++;__mod.keyCombo(vivaldiWindowId+1,'Esc');__mod.KEYBOARD_SHORTCUTS.Esc=old;return calls;})()`),0);
  console.log('PASS shortcuts ignore other windows');
  await evaluate(`(async()=>{const a=await chrome.tabs.create({url:${JSON.stringify(articleURL)},active:true,windowId:vivaldiWindowId});const b=await chrome.tabs.create({url:${JSON.stringify(articleURL)}+'?second',active:false,windowId:vivaldiWindowId});window.__tabs={a:a.id,b:b.id};})()`);
  await until('Number(__mod.getActiveWebview()?.tab_id)===__tabs.a');

  const openSizedDialog=async()=>{
   const id=await evaluate(`(()=>{__mod.showDialog(${JSON.stringify(articleURL)},false);return [...__mod.webviews.keys()].at(-1);})()`);
   await until(`__mod.webviews.get(${JSON.stringify(id)})?.divContainer.isConnected`);
   return id;
  };
  const dialogSize=id=>evaluate(`(()=>{const style=__mod.webviews.get(${JSON.stringify(id)}).divContainer.querySelector('.dialog-tab').style;return [style.width,style.height];})()`);
  const firstA=await openSizedDialog();
  assert.deepEqual(await dialogSize(firstA),['80%','90%']);
  await evaluate('chrome.tabs.update(__tabs.b,{active:true})');
  await until('Number(__mod.getActiveWebview()?.tab_id)===__tabs.b');
  const firstB=await openSizedDialog();
  assert.deepEqual(await dialogSize(firstB),['80%','90%']);
  await evaluate(`__mod.removeDialog(${JSON.stringify(firstB)})`);
  const replacementB=await openSizedDialog();
  assert.deepEqual(await dialogSize(replacementB),['80%','90%']);
  await evaluate('chrome.tabs.update(__tabs.a,{active:true})');
  await until('Number(__mod.getActiveWebview()?.tab_id)===__tabs.a');
  const expectedSizes=[['75%','85%'],['70%','80%'],['65%','75%'],['60%','70%'],['60%','70%']];
  for(const expected of expectedSizes)assert.deepEqual(await dialogSize(await openSizedDialog()),expected);
  await evaluate('for(const id of __mod.webviews.keys())__mod.removeDialog(id)');
  await until('__mod.webviews.size===0');
  console.log('PASS dialog sizes are independent per tab, ignore closing dialogs and stop shrinking at the minimum');
  const delayTab=async()=>evaluate(`(()=>{
   const original=chrome.tabs.create;
   chrome.tabs.create=(properties,callback)=>original(properties,tab=>{chrome.tabs.create=original;window.__createdTab=tab.id;window.__releaseTab=()=>callback(tab);});
   window.__createdTab=undefined;__mod.showDialog(${JSON.stringify(articleURL)},false);
   window.__dialog=[...__mod.webviews.values()].at(-1);
  })()`);
  await delayTab();
  await until('__createdTab');
  await evaluate('chrome.tabs.update(__tabs.b,{active:true})');
  await until('Number(__mod.getActiveWebview()?.tab_id)===__tabs.b');
  await evaluate('__releaseTab()');
  await until('__dialog.divContainer.isConnected');
  assert.equal(await evaluate("Number(__dialog.divContainer.closest('.webpageview').querySelector('webview').tab_id)===__tabs.a"),true);
  await evaluate('chrome.tabs.update(__tabs.a,{active:true})');
  await until('Number(__mod.getActiveWebview()?.tab_id)===__tabs.a');
  await evaluate('__mod.KEYBOARD_SHORTCUTS.Esc()');
  await until('__mod.webviews.size===0');
  console.log('PASS delayed dialog stays on its origin tab and Escape closes it there');
  await delayTab(); await until('__createdTab');
  const abandoned=await evaluate('__createdTab');
  await evaluate('chrome.tabs.remove(__tabs.a)');
  await until('__dialog.lifetime.signal.aborted');
  await evaluate('__releaseTab()');
  await until(`(async()=>{try{await chrome.tabs.get(${abandoned});return false;}catch{return __mod.webviews.size===0;}})()`);
  console.log('PASS closing an origin tab during creation removes its delayed related tab');
  await until('Number(__mod.getActiveWebview()?.tab_id)===__tabs.b');
  await evaluate(`__mod.showDialog(${JSON.stringify(articleURL)},false)`);
  await until('__mod.webviews.size===1&&[...__mod.webviews.values()][0].divContainer.isConnected');
  await evaluate('void (window.__dialog=[...__mod.webviews.values()][0])');
  await until("(async()=>{const tab=await chrome.tabs.get(__dialog.relatedTabId);return tab.status==='complete';})()");
  await evaluate(`(async()=>{__dialog.webview.focus();await new Promise(resolve=>__dialog.webview.executeScript({code:'(()=>{window.getSelection().selectAllChildren(document.querySelector("p"));})()'},resolve));window.__searches=[];__mod.dialogTabSearch=(engine,text)=>__searches.push({engine,text});await __mod.searchForSelectedText();})()`);
  assert.equal(await evaluate('__searches.length===1&&__searches[0].text.includes("Section 0:")'),true);
  console.log('PASS selection search reads the focused dialog');
  await evaluate(`(()=>{const header=__dialog.divContainer.querySelector('.options-container');header.dispatchEvent(new MouseEvent('mouseenter'));window.__commits=[];__dialog.webview.addEventListener('loadcommit',event=>__commits.push({isTopLevel:event.isTopLevel,url:event.url}));})()`);
  await until("!!__dialog.divContainer.querySelector('.reader-view-toggle')");

  assert.equal(await evaluate("__dialog.divContainer.querySelector('input').spellcheck"),false);
  const historyState=()=>evaluate(`({back:__dialog.divContainer.querySelector('.history-back').disabled,forward:__dialog.divContainer.querySelector('.history-forward').disabled})`);
  assert.deepEqual(await historyState(),{back:true,forward:true});
  await evaluate(`new Promise(resolve=>__dialog.webview.executeScript({code:'history.pushState({},"","?spa-history")'},resolve))`);
  await until("!__dialog.divContainer.querySelector('.history-back').disabled");
  assert.deepEqual(await historyState(),{back:false,forward:true});
  await evaluate("__dialog.divContainer.querySelector('.history-back').click()");
  await until("!__dialog.divContainer.querySelector('.history-forward').disabled");
  assert.deepEqual(await historyState(),{back:true,forward:false});
  await evaluate("__dialog.divContainer.querySelector('.history-forward').click()");
  await until("__dialog.divContainer.querySelector('.history-forward').disabled");
  assert.deepEqual(await historyState(),{back:false,forward:true});
  await evaluate("__dialog.divContainer.querySelector('.history-back').click()");
  await until("__dialog.divContainer.querySelector('.history-back').disabled");
  console.log('PASS native history buttons follow SPA navigation, back and forward; spellcheck is disabled');
  await evaluate(`(async()=>{__dialog.divContainer.querySelector('input').focus();__dialog.divContainer.querySelector('.reader-view-toggle').setAttribute('aria-pressed','true');await new Promise(resolve=>__dialog.webview.executeScript({code:'(()=>{const frame=document.createElement("iframe");frame.src='+JSON.stringify(${JSON.stringify(articleURL)}+'?frame')+';document.body.append(frame);})()'},resolve));})()`);
  await until('__commits.some(event=>event.isTopLevel===false)');
  assert.equal(await evaluate("__dialog.divContainer.querySelector('.reader-view-toggle').getAttribute('aria-pressed')"),'true');
  console.log('PASS iframe navigation leaves main-frame reader state unchanged');
  // Use the real chrome.dom API, including a cross-origin iframe hidden in a closed root.
  const playerURL=articleURL.replace('127.0.0.1','localhost').replace('/article','/player-frame');
  await evaluate(`new Promise(resolve=>__dialog.webview.executeScript({code:'(()=>{const host=document.createElement("div");host.style="width:240px;height:130px";document.body.append(host);const shadow=host.attachShadow({mode:"closed"});const frame=document.createElement("iframe");frame.style="width:240px;height:130px";frame.src='+JSON.stringify(${JSON.stringify(playerURL)})+';shadow.append(frame);window.__closedFixture={host,shadow,frame};})()'},resolve))`);
  await until("(async()=>{try{const results=await chrome.scripting.executeScript({target:{tabId:__dialog.relatedTabId,allFrames:true},world:'MAIN',func:()=>Boolean(window.__dialogFullscreenInstalled)});return results.length>=3&&results.every(result=>result.result);}catch{return false;}})()");
  await evaluate(`chrome.scripting.executeScript({target:{tabId:__dialog.relatedTabId,allFrames:true},world:'MAIN',func:()=>{window.__fullEvents=[];for(const type of ['dialog-fullscreen-request','dialog-fullscreen-result'])window.addEventListener(type,event=>__fullEvents.push({type,data:event.detail}));}})`);
  await evaluate(`new Promise(resolve=>__dialog.webview.executeScript({code:'__closedFixture.frame.contentWindow.postMessage({command:"enter"},"*")'},resolve))`);
  try {
  await until(`new Promise(resolve=>__dialog.webview.executeScript({code:'Boolean(document.documentElement.getAttribute("data-dialog-fullscreen")) && Math.abs(__closedFixture.frame.getBoundingClientRect().width-document.documentElement.clientWidth)<1'},results=>resolve(results?.[0])))`);
  } catch(error) {
   console.log('FULLSCREEN_DIAGNOSTICS',await evaluate(`(async()=>{const result={};for(const world of ['ISOLATED','MAIN'])result[world]=await chrome.scripting.executeScript({target:{tabId:__dialog.relatedTabId,allFrames:true},world,func:()=>({url:location.href,controller:window.__dialogFullscreenControllerInstalled,main:window.__dialogFullscreenInstalled,flag:document.documentElement.getAttribute('data-dialog-fullscreen'),body:document.body.outerHTML.slice(0,300),events:window.__fullEvents})});return JSON.stringify(result);})()`));
   console.log('CLOSED_FRAME_GEOMETRY',await evaluate(`new Promise(resolve=>__dialog.webview.executeScript({code:'({width:__closedFixture.frame.getBoundingClientRect().width,viewport:innerWidth,host:__closedFixture.host.outerHTML})'},result=>resolve(result)))`));
   throw error;
  }
  await evaluate('__mod.KEYBOARD_SHORTCUTS.Esc()');
  await until(`new Promise(resolve=>__dialog.webview.executeScript({code:'!document.documentElement.hasAttribute("data-dialog-fullscreen")'},results=>resolve(results?.[0])))`);
  assert.equal(await evaluate('__mod.webviews.size'),1);
  console.log('PASS native DOM access expands a cross-origin iframe inside a closed root; Escape preserves the dialog');
  const closingTab=await evaluate(`(()=>{const original=__dialog.progressBar.destroy.bind(__dialog.progressBar);__dialog.progressBar.destroy=()=>{original();throw new Error('Simulated cleanup failure');};const id=__dialog.relatedTabId;__mod.removeDialog(__dialog.webview.id);return id;})()`);
  await until('__mod.webviews.size===0');
  assert.equal(await evaluate(`(async()=>{try{await chrome.tabs.get(${closingTab});return false;}catch{return true;}})()`),true);
  console.log('PASS a failing cleanup step still closes the related tab and removes the dialog');
  let secondWindow=await evaluate(`(async()=>{const core=chrome.extension.getViews().find(view=>view.location.href===chrome.runtime.getURL('main.html'));const create=core.chrome.contextMenus.create;core.__dialogCreateCount=0;core.chrome.contextMenus.create=(...args)=>{core.__dialogCreateCount++;return create(...args);};core.__dialogRestoreCreate=()=>{core.chrome.contextMenus.create=create;};window.__menuHits=[];__mod.dialogTab=url=>__menuHits.push(url);const result=await chrome.windows.create({url:'about:blank',incognito:true});return result?.id;})()`);
  let secondTarget;
  for(let i=0;i<50;i++){const found=await call('Target.getTargets');secondTarget=found.targetInfos.find(target=>target.url.endsWith('/window.html')&&target.targetId!==ui.targetId);if(secondTarget)break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(secondTarget,'Missing second Vivaldi window');
  let {sessionId:secondSession}=await call('Target.attachToTarget',{targetId:secondTarget.targetId,flatten:true});
  for(let i=0;i<50;i++){if(await evaluate("!!document.getElementById('browser')",secondSession))break;await new Promise(resolve=>setTimeout(resolve,100));}
  secondWindow=await evaluate('vivaldiWindowId',secondSession);
  await evaluate(instrumented,secondSession);
  await evaluate(`window.__mod=new __dialogClasses.DialogMod();window.__menuHits=[];__mod.dialogTab=url=>__menuHits.push(url);__mod.searchEngineUtils.ready`,secondSession);

  assert.equal(await evaluate('__mod.searchEngineUtils.incognito',secondSession),true);
  for(let i=0;i<80;i++){if(await evaluate("!!__mod.getActiveWebview()",secondSession))break;await new Promise(resolve=>setTimeout(resolve,100));}
  await evaluate(`(()=>{window.__privateRequests=[];const original=vivaldi.searchEngines.getSearchRequest;window.__restoreSearch=()=>{vivaldi.searchEngines.getSearchRequest=original;};vivaldi.searchEngines.getSearchRequest=async(engine,text)=>{__privateRequests.push({engine,text});return {url:${JSON.stringify(articleURL)}+'?private-search'};};__mod.showDialog(${JSON.stringify(articleURL)},false);})()`,secondSession);
  for(let i=0;i<80;i++){if(await evaluate("__mod.webviews.size===1&&[...__mod.webviews.values()][0].divContainer.isConnected",secondSession))break;await new Promise(resolve=>setTimeout(resolve,100));}
  await evaluate(`window.__privateDialog=[...__mod.webviews.values()][0];__privateDialog.divContainer.querySelector('.options-container').dispatchEvent(new MouseEvent('mouseenter'))`,secondSession);
  for(let i=0;i<80;i++){if(await evaluate("!!__privateDialog.divContainer.querySelector('input')",secondSession))break;await new Promise(resolve=>setTimeout(resolve,100));}
  await evaluate(`(()=>{const input=__privateDialog.divContainer.querySelector('input');input.focus();input.value='private query';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`,secondSession);
  for(let i=0;i<80;i++){if(await evaluate('__privateRequests.length===1',secondSession))break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(await evaluate('__privateRequests[0].engine===__mod.searchEngineUtils.privateSearchId',secondSession),true);
  await evaluate(`(()=>{const input=__privateDialog.divContainer.querySelector('input');input.value='private tab query';return __mod.openNewTab(input.id,false);})()`,secondSession);
  assert.equal(await evaluate('__privateRequests[1].engine===__mod.searchEngineUtils.privateSearchId',secondSession),true);
  await evaluate('__restoreSearch();__mod.removeDialog(__privateDialog.webview.id)',secondSession);
  console.log('PASS input searches and new-tab searches use the private engine in a real private window');

  // Private windows have their own extension context. Check shared menus between normal windows separately.
  const privateTargetId=secondTarget.targetId;
  await evaluate(`void chrome.windows.remove(${secondWindow})`,secondSession);
  secondWindow=await evaluate("(async()=>{const result=await chrome.windows.create({url:'about:blank'});return result.id;})()");
  secondTarget=undefined;
  for(let i=0;i<50;i++){const found=await call('Target.getTargets');secondTarget=found.targetInfos.find(target=>target.url.endsWith('/window.html')&&target.targetId!==ui.targetId&&target.targetId!==privateTargetId);if(secondTarget)break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(secondTarget,'Missing second normal Vivaldi window');
  ({sessionId:secondSession}=await call('Target.attachToTarget',{targetId:secondTarget.targetId,flatten:true}));
  for(let i=0;i<50;i++){if(await evaluate("!!document.getElementById('browser')",secondSession))break;await new Promise(resolve=>setTimeout(resolve,100));}
  await evaluate(instrumented,secondSession);
  await evaluate(`window.__mod=new __dialogClasses.DialogMod();window.__menuHits=[];__mod.dialogTab=url=>__menuHits.push(url);__mod.searchEngineUtils.ready`,secondSession);
  assert.equal(await evaluate(`chrome.extension.getViews().find(view=>view.location.href===chrome.runtime.getURL('main.html')).__dialogCreateCount`,secondSession),0);
  await evaluate(`(()=>{const core=chrome.extension.getViews().find(view=>view.location.href===chrome.runtime.getURL('main.html'));core.__dialogMenuHandler({menuItemId:'dialog-tab-link',linkUrl:'https://example.test/second'},{windowId:${secondWindow}});core.__dialogRestoreCreate();})()`,secondSession);
  assert.deepEqual(await evaluate('__menuHits',secondSession),['https://example.test/second']);
  assert.deepEqual(await evaluate('__menuHits'),[]);
  const firstWindow=await evaluate('vivaldiWindowId');
  await evaluate(`chrome.windows.remove(${firstWindow})`,secondSession);
  await evaluate(`chrome.extension.getViews().find(view=>view.location.href===chrome.runtime.getURL('main.html')).__dialogMenuHandler({menuItemId:'dialog-tab-link',linkUrl:'https://example.test/after-close'},{windowId:${secondWindow}})`,secondSession);
  assert.deepEqual(await evaluate('__menuHits',secondSession),['https://example.test/second','https://example.test/after-close']);
  console.log('PASS multiple windows share menus and keep them usable after the first window closes');
 } finally {
  ws?.close();child.kill('SIGTERM');server.close();
  await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},3000);child.on('exit',()=>{clearTimeout(timer);resolve();});});
  try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
 }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
