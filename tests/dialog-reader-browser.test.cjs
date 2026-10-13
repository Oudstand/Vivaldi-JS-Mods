// Run with: node tests/dialog-reader-browser.test.cjs
// Uses Vivaldi's real UI and an isolated temporary profile, never the user's browser profile.
// DIALOG_READER_BROWSER and DIALOG_READER_CSS can override the binary and sibling CSS checkout.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const http = require('node:http');
(async () => {
 const browser=process.env.DIALOG_READER_BROWSER||['/opt/vivaldi-snapshot/vivaldi-bin','/opt/vivaldi/vivaldi-bin'].find(candidate=>fs.existsSync(candidate));
 const cssPath=process.env.DIALOG_READER_CSS||path.resolve(__dirname,'../../CSS/dialog.css');
 if(!browser||!fs.existsSync(cssPath)){console.log('SKIP native reader browser test: Vivaldi and dialog.css are required.');return;}
 const articleHTML='<!doctype html><title>Native reader test article</title><header id="original-navigation">Original site navigation</header><article><h1>Native reader test article</h1>'+Array.from({length:20},(_,i)=>'<p>Section '+i+': This is a detailed article about reading in a Vivaldi dialog. The native reader should extract the article content and preserve normal navigation through the existing related tab. Each paragraph explains the test clearly and provides enough text for article recognition.</p>').join('')+'</article>';
 const server=http.createServer((request,response)=>{response.setHeader('Content-Type','text/html; charset=utf-8');response.end(articleHTML);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const articleURL='http://127.0.0.1:'+server.address().port+'/article';
 const css=fs.readFileSync(cssPath,'utf8');
 const source=fs.readFileSync(path.join(__dirname,'../dialog.js'),'utf8');
 const readerClass=source.slice(source.indexOf('    class ReaderView {'),source.indexOf('    class ProgressBar {'));
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
  const setup=readerClass+`
(async()=>{const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);const tab=await chrome.tabs.create({url:${JSON.stringify(articleURL)},active:false,windowId:vivaldiWindowId,vivExtData:JSON.stringify({panelId:'dialog-native-reader-test'})});const webview=document.createElement('webview');webview.tab_id=String(tab.id);webview.setAttribute('tab_id',String(tab.id));webview.setAttribute('parent_tab_id','0');webview.setAttribute('name','vivaldi-dialog');webview.style.cssText='width:100%;flex:1;min-height:0';const overlay=document.createElement('div');overlay.className='dialog-container is-open';overlay.style.zIndex='99999';const dialog=document.createElement('div');dialog.className='dialog-tab';dialog.style.cssText='width:80%;height:80%';const controller=new AbortController();const controls=ReaderView.createControls(webview,controller.signal);const content=document.createElement('div');content.className='dialog-page-content';content.append(controls,webview);dialog.append(content);overlay.append(dialog);document.getElementById('browser').append(overlay);window.__readerProbe={webview,tabId:tab.id,controls,controller};return tab.id;})()`;
  const tabId=await evaluate(setup);console.log('Created related tab',tabId);
  const waitFor=async(expression)=>{for(let i=0;i<40;i++){const result=await evaluate(expression);if(result)return result;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Timed out: '+expression);};
  await waitFor(`(async()=>{const tab=await chrome.tabs.get(__readerProbe.tabId);return tab.status==='complete'&&tab.url===${JSON.stringify(articleURL)};})()`);
  console.log('Initial webview',await evaluate(`JSON.stringify({src:__readerProbe.webview.src,historyAPI:typeof __readerProbe.webview.getPageHistory})`));
  await evaluate(`(()=>{
   const node=document.querySelector('.webpageview');
   let fiber=node[Object.keys(node).find(key=>key.startsWith('__reactFiber'))];
   while(fiber&&!fiber.stateNode?.render?.toString().includes('webpage-stack'))fiber=fiber.return;
   if(!fiber)throw new Error('Missing native page stack');
   window.__stackProbe={host:fiber.stateNode,original:fiber.stateNode.render,webview:node.querySelector('webview')};
  })()`);
  await evaluate('ReaderView.toggle(__readerProbe.webview)');
  await waitFor("(async()=>{const tab=await chrome.tabs.get(__readerProbe.tabId);return tab.status==='complete'&&tab.url.startsWith('chrome://reader/');})()");
  targets=await call('Target.getTargets');
  const readerTarget=targets.targetInfos.find(t=>t.url.startsWith('chrome://reader/'));
  if(!readerTarget)throw new Error('No native reader target');
  const {sessionId:readerSession}=await call('Target.attachToTarget',{targetId:readerTarget.targetId,flatten:true});
  let rendered;
  for(let i=0;i<40;i++){
   rendered=await evaluate("JSON.stringify({url:location.href,title:document.title,text:document.querySelector('#reader-article')?.innerText,error:document.querySelector('#reader-error')?.innerText})",readerSession);
   if(JSON.parse(rendered).text?.includes('Section 19:'))break;
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  const state=JSON.parse(rendered);
  if(!state.text?.includes('Section 19:'))throw new Error('Native reader did not render article: '+rendered);
  console.log('Native reader rendered original article',JSON.stringify({url:state.url,title:state.title,characters:state.text.length}));

  const clickNative=async(title,root='__readerProbe.controls')=>{
   const position=await evaluate(`(()=>{const button=Array.from(${root}.querySelectorAll('button')).find(button=>button.title===${JSON.stringify(title)});if(!button)throw new Error('Missing native button '+${JSON.stringify(title)});if(button.disabled)throw new Error('Native button is disabled '+${JSON.stringify(title)});const rect=button.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2,hit:button.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2))};})()`);
   if(!position.hit)throw new Error('Native button is obscured: '+title);
   const {x,y}=position;
   await call('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1},uiSession);
   await call('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1},uiSession);
  };
  const waitReader=async expression=>{
   for(let i=0;i<50;i++){const value=await evaluate(expression,readerSession);if(value)return value;await new Promise(resolve=>setTimeout(resolve,100));}
   throw new Error('Reader timed out: '+expression);
  };
  const nativeButton=(title,property,root='__readerProbe.controls')=>`${root}.querySelectorAll('.reader-toolbar button')[__readerProbe.buttonIndex[${JSON.stringify(title)}]]?.${property}`;
  await waitFor("!!__readerProbe.controls.querySelector('.reader-settings-toggle button')");
  await clickNative('Reader settings');
  await waitFor("__readerProbe.controls.querySelector('.reader-toolbar')?.getBoundingClientRect().height===40");
  await evaluate("__readerProbe.buttonIndex=Object.fromEntries(Array.from(__readerProbe.controls.querySelectorAll('.reader-toolbar button'),(button,index)=>[button.title,index]))");
  console.log('Original native settings gear opens original native toolbar');
  const count=await evaluate("__readerProbe.controls.querySelectorAll('.reader-toolbar button').length");
  if(count<13)throw new Error('Native controls missing: '+count);
  await evaluate("(async()=>{const {value}=await vivaldi.prefs.get(ReaderView.STYLE_PREF);await vivaldi.prefs.set({path:ReaderView.STYLE_PREF,value:{...value,width:36}});})()");
  await waitReader("document.body.style.getPropertyValue('--reader-measure')==='36ch'");
  const columnWidth=await evaluate("document.getElementById('reader-article').getBoundingClientRect().width",readerSession);
  await clickNative('Full width');
  await waitReader("document.body.style.getPropertyValue('--reader-measure')==='none'");
  await waitFor(nativeButton('Full width',"classList.contains('button-pressed')"));
  await waitFor(nativeButton('Shrink column','disabled')+'&&'+nativeButton('Grow column','disabled'));
  const fullWidth=await evaluate("document.getElementById('reader-article').getBoundingClientRect().width",readerSession);
  if(fullWidth<=columnWidth)throw new Error('Native full width did not enlarge article');
  await new Promise(resolve=>setTimeout(resolve,350));
  await clickNative('Reading column');
  await waitReader("document.body.style.getPropertyValue('--reader-measure')==='36ch'");
  console.log('Native full width and column controls work',JSON.stringify({columnWidth,fullWidth}));
  await new Promise(resolve=>setTimeout(resolve,350));
  await clickNative('Increase font size');
  await waitReader("Math.abs(parseFloat(getComputedStyle(document.body).fontSize)-22.4)<0.01");
  await new Promise(resolve=>setTimeout(resolve,350));
  await clickNative('Loosen line spacing');
  await waitFor("(async()=>{const {value}=await vivaldi.prefs.get(ReaderView.STYLE_PREF);return value.lineHeight===1.6;})()");
  await new Promise(resolve=>setTimeout(resolve,350));
  await clickNative('Grow column');
  await waitReader("document.body.style.getPropertyValue('--reader-measure')==='38ch'");
  console.log('Native font, line spacing and column actions update reader');
  for(const [title,wanted] of [['Dark','dark'],['Light','light'],['Inherit Theme','theme']]){
   await new Promise(resolve=>setTimeout(resolve,350));
   await clickNative(title);
   await waitReader(`document.body.dataset.theme===${JSON.stringify(wanted)}`);
   await waitFor(nativeButton(title,"classList.contains('button-pressed')"));
   if(wanted==='theme'){
    const result=await evaluate("({bg:document.body.style.getPropertyValue('--reader-bg'),fg:document.body.style.getPropertyValue('--reader-fg'),link:document.body.style.getPropertyValue('--reader-link')})",readerSession);
    if(!result.bg||!result.fg||!result.link)throw new Error('Native browser theme colors missing '+JSON.stringify(result));
    console.log('Native browser theme provides all colors',JSON.stringify(result));
   }
  }
  await evaluate(`(()=>{const {require}=ReaderView.getNativeControls(__readerProbe.webview);const id=Object.keys(require.m).find(id=>require.m[id].toString().includes('getCurrentIdWithoutPreview:'));window.__themeActions=Object.values(require(id)).find(value=>typeof value?.setTheme==='function'&&typeof value?.getCurrentThemeAndStyle==='function');window.__oldThemeId=__themeActions.getCurrentId();})()`);
  const oldTheme=await evaluate("document.body.style.getPropertyValue('--reader-bg')",readerSession);
  await evaluate("__themeActions.setTheme('Vivaldi2')");
  await waitReader(`document.body.style.getPropertyValue('--reader-bg')&&document.body.style.getPropertyValue('--reader-bg')!==${JSON.stringify(oldTheme)}`);
  await evaluate("__themeActions.setTheme(__oldThemeId)");
  await waitReader(`document.body.style.getPropertyValue('--reader-bg')===${JSON.stringify(oldTheme)}`);
  console.log('Native reader follows actual browser theme changes');
  await evaluate("(async()=>{const {value}=await vivaldi.prefs.get(ReaderView.STYLE_PREF);await vivaldi.prefs.set({path:ReaderView.STYLE_PREF,value:{...value,fontSize:4,lineHeight:2,width:100}});})()");
  await waitFor(nativeButton('Increase font size','disabled')+'&&'+nativeButton('Loosen line spacing','disabled')+'&&'+nativeButton('Grow column','disabled'));
  await evaluate("(async()=>{const {value}=await vivaldi.prefs.get(ReaderView.STYLE_PREF);await vivaldi.prefs.set({path:ReaderView.STYLE_PREF,value:{...value,fontSize:0.5,lineHeight:1,width:20}});})()");
  await waitFor(nativeButton('Decrease font size','disabled')+'&&'+nativeButton('Tighten line spacing','disabled')+'&&'+nativeButton('Shrink column','disabled'));
  console.log('Native limits and external preference updates reflected in buttons');
  await evaluate("(async()=>{const {value}=await vivaldi.prefs.get(ReaderView.STYLE_PREF);await vivaldi.prefs.set({path:ReaderView.STYLE_PREF,value:{...value,fontSize:1.3,lineHeight:1.5,width:64}});})()");
  const joined=await evaluate("(()=>{const root=__readerProbe.controls,content=root.parentElement;const r=root.getBoundingClientRect(),w=__readerProbe.webview.getBoundingClientRect();return getComputedStyle(content).overflow==='hidden'&&getComputedStyle(content).borderRadius!=='0px'&&Math.abs(r.bottom-w.top)<1&&r.width===w.width;})()");
  if(!joined)throw new Error('Native toolbar not integrated into rounded frame');
  await new Promise(resolve=>setTimeout(resolve,300));
  await evaluate("__readerProbe.controls.closest('.dialog-tab').style.width='260px'");
  const narrow=await evaluate(`(()=>{const toolbar=__readerProbe.controls.querySelector('.reader-toolbar'),buttons=toolbar.querySelectorAll('button');const hit=button=>{const r=button.getBoundingClientRect();return button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));};toolbar.scrollLeft=0;const first=hit(buttons[0]);toolbar.scrollLeft=toolbar.scrollWidth;return {overflow:toolbar.scrollWidth>toolbar.clientWidth,first,last:hit(buttons[buttons.length-1]),gear:hit(__readerProbe.controls.querySelector('.reader-settings-toggle button'))};})()`);
  if(!narrow.overflow||!narrow.first||!narrow.last||!narrow.gear)throw new Error('Native narrow toolbar failed '+JSON.stringify(narrow));
  console.log('Native toolbar scrolls and gear stays reachable in 260px dialog');
  await clickNative('Reader settings');
  await waitFor("!__readerProbe.controls.querySelector('.reader-toolbar')");
  if(!await evaluate("__readerProbe.controls.getBoundingClientRect().height===0"))throw new Error('Collapsed native toolbar leaves blank area');
  if(!await evaluate("document.querySelector('.webpageview webview')===__stackProbe.webview"))throw new Error('Native main webview was replaced');
  await evaluate('ReaderView.toggle(__readerProbe.webview)');
  await waitFor(`(async()=>{const tab=await chrome.tabs.get(__readerProbe.tabId);return tab.status==='complete'&&tab.url===${JSON.stringify(articleURL)};})()`);
  await waitFor("__readerProbe.controls.children.length===0&&__stackProbe.host.render===__stackProbe.original");
  console.log('Leaving reader restores original native renderer and preserves main webview');
  await evaluate('ReaderView.toggle(__readerProbe.webview)');
  await waitFor("!!__readerProbe.controls.querySelector('.reader-settings-toggle button')");
  console.log('Native toolbar can mount again after navigation');
  await evaluate(`(async()=>{
   const tab=await chrome.tabs.create({url:${JSON.stringify(articleURL)},active:false,windowId:vivaldiWindowId,vivExtData:JSON.stringify({panelId:'dialog-native-reader-second'})});
   const webview=document.createElement('webview');webview.tab_id=String(tab.id);webview.setAttribute('tab_id',String(tab.id));webview.setAttribute('parent_tab_id','0');webview.setAttribute('name','vivaldi-dialog');
   const controller=new AbortController(),controls=ReaderView.createControls(webview,controller.signal);
   const content=document.createElement('div');content.className='dialog-page-content';content.append(controls,webview);
   const dialog=document.createElement('div');dialog.className='dialog-tab';dialog.style.cssText='width:80%;height:80%';dialog.append(content);
   const overlay=document.createElement('div');overlay.className='dialog-container is-open';overlay.style.zIndex='999999';overlay.append(dialog);document.getElementById('browser').append(overlay);
   window.__secondReader={webview,controller,controls,overlay,tabId:tab.id};
  })()`);
  await waitFor(`(async()=>{const tab=await chrome.tabs.get(__secondReader.tabId);return tab.status==='complete'&&tab.url===${JSON.stringify(articleURL)};})()`);
  await evaluate('ReaderView.toggle(__secondReader.webview)');
  await waitFor("!!__secondReader.controls.querySelector('.reader-settings-toggle button')");
  await clickNative('Reader settings','__secondReader.controls');
  await waitFor("__secondReader.controls.querySelector('.reader-toolbar')?.getBoundingClientRect().height===40");
  await clickNative('Full width','__secondReader.controls');
  await waitFor("(async()=>{const {value}=await vivaldi.prefs.get(ReaderView.STYLE_PREF);return value.fullWidth===true;})()");
  await evaluate('__readerProbe.controller.abort()');
  await waitFor("__readerProbe.controls.children.length===0&&!!__secondReader.controls.querySelector('.reader-toolbar')");
  if(!await evaluate('__stackProbe.host.render===__stackProbe.original'))throw new Error('Native page renderer was modified');
  await evaluate("chrome.tabs.create({url:'about:blank',active:true,windowId:vivaldiWindowId})");
  await new Promise(resolve=>setTimeout(resolve,300));
  if(!await evaluate("!!__secondReader.controls.querySelector('.reader-toolbar')"))throw new Error('Native toolbar disappeared after switching main tab');
  await evaluate('__secondReader.controller.abort()');
  await waitFor("__secondReader.controls.children.length===0&&__stackProbe.host.render===__stackProbe.original");
  console.log('Multiple native toolbars survive tab switching and clean up independently');
 } finally {
  ws?.close();child.kill('SIGTERM');server.close();
  await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},3000);child.on('exit',()=>{clearTimeout(timer);resolve();});});
  try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
 }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
