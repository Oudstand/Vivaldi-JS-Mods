const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../domain-title-bar.js'), 'utf8');
const deferred = () => {let resolve, reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const settle = async () => {for(let i=0;i<6;i++)await Promise.resolve();};

function fixture({tab={id:1,windowId:10,active:true,url:'http://www.example.test:8123/path?q=1',title:'Article'}, query, get, management}={}) {
    class Element extends EventTarget {
        constructor(name='div',classes='') {super();this.nodeType=1;this.name=name;this.className=classes;this.children=[];this.dataset={};this.textContent='';this.parent=null;}
        matches(selector) {return selector.split(',').some(s=>s.trim().startsWith('.')&&this.className.split(' ').includes(s.trim().slice(1)));}
        querySelector(selector) {for(const child of this.children){if(child.matches(selector))return child;const found=child.querySelector(selector);if(found)return found;}return null;}
        appendChild(child) {child.parent=this;this.children.push(child);return child;}
        insertBefore(child,other) {child.parent=this;const index=this.children.indexOf(other);index<0?this.children.push(child):this.children.splice(index,0,child);return child;}
        remove() {if(this.parent)this.parent.children.splice(this.parent.children.indexOf(this),1);}
        getAttribute(name) {return this[name] ?? null;}
        setAttribute(name,value) {this[name]=value;}
        removeAttribute(name) {delete this[name];}
    }
    const root=new Element(),head=new Element('head'),browser=new Element();
    const field=browser.appendChild(new Element('div','UrlBar-AddressField'));
    const inputWrapper=field.appendChild(new Element('div','UrlBar-UrlFieldWrapper'));
    const wrapper=inputWrapper.appendChild(new Element('div','UrlFragment-Wrapper'));
    const frames=new Map(),observers=[],updates=[],queries=[],lookups=[],events={};let next=0;
    for(const name of ['onActivated','onUpdated','onRemoved','onReplaced']) {const listeners=new Set();events[name]={listeners,addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn),emit:(...args)=>listeners.forEach(fn=>fn(...args))};}
    const windowEvents=new EventTarget();
    const context={URL,AbortController,Node:{ELEMENT_NODE:1},console:{debug(){}},
        document:{head,documentElement:root,getElementById:id=>id==='browser'?browser:null,createElement:name=>new Element(name),
            querySelector:selector=>selector==='#browser .UrlBar-AddressField'?browser.querySelector('.UrlBar-AddressField'):null,
            querySelectorAll:()=>{const nodes=[];const scan=el=>{for(const child of el.children){if(child.matches('.DomainButton,.PageTitle'))nodes.push(child);scan(child);}};scan(browser);return nodes;}},
        MutationObserver:class{constructor(fn){this.fn=fn;observers.push(this);}observe(){this.active=true;}disconnect(){this.active=false;}},
        requestAnimationFrame:fn=>{const id=++next;frames.set(id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id),
        addEventListener:windowEvents.addEventListener.bind(windowEvents),window:{},vivaldiWindowId:10,
        chrome:{tabs:{...events,query:async options=>{queries.push(options);return query?query(options):tab?[tab]:[];},get:async id=>get?get(id):tab,update:async(id,options)=>updates.push({id,...options})},
            management:{get:async id=>{lookups.push(id);return management?management(id):{name:'Extension name'};}}}
    };
    vm.runInNewContext(source.replace('    initMod();','    window.DomainTitleBar=DomainTitleBar;'),context);
    const mod=new context.window.DomainTitleBar();
    const f={mod,Class:context.window.DomainTitleBar,context,field,wrapper,browser,Element,events,frames,observers,updates,queries,lookups,windowEvents};
    f.flush=async()=>{await settle();for(const [id,fn]of [...frames]){frames.delete(id);fn();}await settle();};
    f.state=()=>({domain:browser.querySelector('.DomainText')?.textContent,title:browser.querySelector('.PageTitle')?.textContent,disabled:browser.querySelector('.DomainButton')?.disabled});
    f.update=async(changes,other={})=>{tab={...tab,...changes,...other};events.onUpdated.emit(tab.id,changes,tab);await f.flush();};
    f.mutate=(added=[],removed=[])=>observers.filter(o=>o.active).forEach(o=>o.fn([{addedNodes:added,removedNodes:removed}]));
    return f;
}

test('URL targets preserve protocols, ports and internal routes, and omit HTTP credentials',()=>{
    const f=fixture();
    const cases=[
        ['http://www.example.test:8123/a?b#c','www.example.test:8123','http://www.example.test:8123/'],
        ['https://user:password@example.test/a','example.test','https://example.test/'],
        ['http://[::1]:8123/a','[::1]:8123','http://[::1]:8123/'],
        ['vivaldi://settings/keyboard/','vivaldi:settings','vivaldi://settings/keyboard/'],
        ['vivaldi:settings','vivaldi:settings','vivaldi://settings'],
        ['chrome://startpage/','vivaldi:startpage','chrome://startpage/'],
        ['about:blank','about:blank','about:blank'],
        ['file:///tmp/article.html','file',null],
        ['data:text/html,example','data',null],
        ['not a URL','',null]
    ];
    for(const [url,domain,target]of cases){const result=f.Class.getUrlInfo(url);assert.equal(result.domain,domain,url);assert.equal(result.target,target,url);}
    f.mod.destroy();
});

test('native tab metadata drives display and domain navigation without reading URL fragments',async()=>{
    const f=fixture();await f.flush();
    assert.equal(f.queries[0].windowId,10);assert.deepEqual(f.state(),{domain:'example.test:8123',title:'Article',disabled:false});
    f.browser.querySelector('.DomainButton').dispatchEvent(new Event('click'));await settle();
    assert.deepEqual(f.updates,[{id:1,url:'http://www.example.test:8123/'}]);
    await f.update({url:'http://changed.test/route',title:'SPA title'});
    assert.deepEqual(f.state(),{domain:'changed.test',title:'SPA title',disabled:false});
});

test('updates from other windows and background tabs leave the display unchanged',async()=>{
    const f=fixture();await f.flush();
    f.events.onActivated.emit({windowId:11,tabId:2});
    f.events.onUpdated.emit(2,{title:'Other'},{id:2,windowId:10,active:false,url:'https://other.test/',title:'Other'});
    f.events.onUpdated.emit(1,{title:'Other window'},{id:1,windowId:11,active:true,url:'https://other.test/'});
    await f.flush();assert.equal(f.state().title,'Article');assert.equal(f.queries.length,1);
});

test('late initial queries cannot overwrite a newly activated tab',async()=>{
    const pending=deferred();const second={id:2,windowId:10,active:true,url:'https://second.test/',title:'Second'};
    const f=fixture({query:()=>pending.promise,get:()=>second});
    f.events.onActivated.emit({windowId:10,tabId:2});await f.flush();
    pending.resolve([{id:1,windowId:10,active:true,url:'http://old.test/',title:'Old'}]);await f.flush();
    assert.equal(f.state().domain,'second.test');assert.equal(f.state().title,'Second');
});

test('stale extension lookups are ignored and successful lookups are reused',async()=>{
    const pending=deferred(),id='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const f=fixture({management:()=>pending.promise});await f.flush();
    await f.update({url:'chrome-extension://'+id+'/page.html',title:'Vivaldi'});
    assert.equal(f.state().disabled,true);
    await f.update({url:'https://current.test/',title:'Current'});
    pending.resolve({name:'Old extension'});await f.flush();assert.equal(f.state().domain,'current.test');
    await f.update({url:'chrome-extension://'+id+'/next.html',title:'Vivaldi'});
    assert.equal(f.state().domain,'Old extension');assert.equal(f.lookups.length,1);
});

test('failed extension lookups have a non-clickable fallback',async()=>{
    const f=fixture({management:async()=>{throw Error('Missing extension');}});await f.flush();
    await f.update({url:'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/page.html',title:'Vivaldi'});
    assert.equal(f.state().domain,'Extension');assert.equal(f.state().disabled,true);
    f.browser.querySelector('.DomainButton').dispatchEvent(new Event('click'));assert.equal(f.updates.length,0);
});

test('pending navigation does not reuse the previous page title and untitled roots have a fallback',async()=>{
    const f=fixture();await f.flush();await f.update({pendingUrl:'https://pending.test/article'});
    assert.equal(f.state().title,'pending.test');
    await f.update({url:'https://pending.test/',pendingUrl:'',title:'Vivaldi'});assert.equal(f.state().title,'pending.test');
});

test('toolbar and title removal are repaired without polling or browser-class changes',async()=>{
    const f=fixture();await f.flush();const old=f.field;old.remove();
    const field=f.browser.appendChild(new f.Element('div','UrlBar-AddressField'));
    const wrapper=field.appendChild(new f.Element('div','UrlFragment-Wrapper'));
    f.mutate([field],[old]);await f.flush();assert.equal(f.state().title,'Article');assert.equal(f.state().domain,'example.test:8123');
    const title=wrapper.querySelector('.PageTitle');title.remove();f.mutate([],[title]);await f.flush();assert.equal(f.state().title,'Article');
    wrapper.remove();f.mutate([],[wrapper]);await f.flush();assert.equal(f.frames.size,0);
    f.mutate([{nodeType:3}],[]);assert.equal(f.frames.size,0);
});

test('a stale visible button cannot navigate a newly activated tab before its metadata arrives',async()=>{
    const pending=deferred();const f=fixture({get:()=>pending.promise});await f.flush();const button=f.browser.querySelector('.DomainButton');
    f.events.onActivated.emit({windowId:10,tabId:2});button.dispatchEvent(new Event('click'));assert.equal(f.updates.length,0);
    f.mutate([f.field]);await f.flush();assert.equal(f.state().disabled,true);
    pending.resolve({id:2,windowId:10,active:true,url:'https://second.test/',title:'Second'});await f.flush();
    button.dispatchEvent(new Event('click'));await settle();assert.deepEqual(f.updates,[{id:2,url:'https://second.test/'}]);
});

test('tab replacement and an empty window clear or update the displayed metadata',async()=>{
    let current={id:1,windowId:10,active:true,url:'https://initial.test/',title:'Initial'};
    const f=fixture({query:()=>current?[current]:[],get:()=>current});await f.flush();
    current={id:3,windowId:10,active:true,url:'https://replacement.test/',title:'Replacement'};
    f.events.onReplaced.emit(3,1);await f.flush();assert.equal(f.state().domain,'replacement.test');
    current=null;f.events.onRemoved.emit(3);await f.flush();assert.deepEqual(f.state(),{domain:'',title:'',disabled:true});
});

test('cleanup removes listeners, owned elements and scheduled work, and rejects late results',async()=>{
    const pending=deferred();const f=fixture({query:()=>pending.promise});f.mod.destroy();f.mod.destroy();
    pending.resolve([{id:1,windowId:10,active:true,url:'https://late.test/',title:'Late'}]);await f.flush();
    assert.equal(f.frames.size,0);assert.equal(Object.values(f.events).every(event=>event.listeners.size===0),true);
    assert.equal(f.observers.every(observer=>!observer.active),true);assert.equal(f.browser.querySelector('.DomainButton'),null);
    const active=fixture();await active.flush();active.windowEvents.dispatchEvent(new Event('unload'));assert.equal(active.browser.querySelector('.PageTitle'),null);
});

