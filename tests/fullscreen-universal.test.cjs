const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../fullscreen-universal.js'), 'utf8');

function fixture(options = {}) {
    class Element extends EventTarget {
        constructor(tag = 'div', id = '', classes = '') {
            super(); this.nodeType = 1; this.tagName = tag; this.id = id; this.children = []; this.childNodes = this.children;
            this.parentNode = null; this.isConnected = true; this.offsetWidth = 40; this.offsetHeight = 30;
            this.names = new Set(classes.split(' ').filter(Boolean));
            this.classList = {add: (...names) => names.forEach(name => this.names.add(name)), remove: (...names) => names.forEach(name => this.names.delete(name)), contains: name => this.names.has(name)};
            this.style = {setProperty(name, value) {this[name] = value;}, getPropertyValue(name) {return this[name] || '';}};
            this.textContent = '';
        }
        set className(value) {this.names = new Set(value.split(' ').filter(Boolean));}
        get className() {return [...this.names].join(' ');}
        appendChild(child) {child.parentNode = this; child.isConnected = true; this.children.push(child); return child;}
        remove() {if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.isConnected = false;}
        matches(selector) {return selector.split(',').some(part => {part = part.trim(); return part === ':hover' ? false : part.startsWith('#') ? this.id === part.slice(1) : part.startsWith('.') && this.names.has(part.slice(1));});}
        querySelector(selector) {for (const child of this.children) {if (child.matches(selector)) return child; const found = child.querySelector(selector); if (found) return found;} return null;}
    }
    const root = new Element('html'), head = root.appendChild(new Element('head')), app = root.appendChild(new Element('div', 'app'));
    const browser = app.appendChild(new Element('div', 'browser', 'address-top bookmark-bar-top'));
    const elements = {root, head, app, browser};
    for (const [name, id, classes] of [['header','header',''], ['mainbar','','mainbar'], ['bookmarks','','bookmark-bar'], ['footer','footer',''], ['tabs','tabs-tabbar-container','left'], ['panels','panels-container','left'], ['webview','webview-container','']]) {
        elements[name] = browser.appendChild(new Element('div', id, classes));
    }
    elements.wrapper = elements.tabs.appendChild(new Element('div', '', 'tabbar-wrapper'));
    elements.wrapper.offsetWidth = 200;
    elements.footer.appendChild(new Element());
    const events = new EventTarget(), shortcuts = new Set(), mutations = [], resizes = [], timers = new Map(), saved = [];
    let now = 0, next = 0, resolveStorage, rejectStorage;
    const schedule = (fn, delay = 0) => {const id = ++next; timers.set(id, {fn, due: now + delay}); return id;};
    const tick = delay => {
        const end = now + delay;
        for (;;) {const entry = [...timers].sort((a,b) => a[1].due - b[1].due).find(([,timer]) => timer.due <= end); if (!entry) break; timers.delete(entry[0]); now = entry[1].due; entry[1].fn();}
        now = end;
    };
    const storage = new Promise((resolve, reject) => {resolveStorage = resolve; rejectStorage = reject;});
    const context = {
        console: {debug() {}}, AbortController, Node: {ELEMENT_NODE: 1},
        document: {head, documentElement: root, createElement: tag => new Element(tag), querySelector: selector => root.querySelector(selector), getElementById: id => root.querySelector('#' + id)},
        addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
        setTimeout: schedule, clearTimeout: id => timers.delete(id), requestAnimationFrame: fn => schedule(fn, 16), cancelAnimationFrame: id => timers.delete(id),
        MutationObserver: class {constructor(fn) {this.fn = fn; mutations.push(this);} observe() {this.active = true;} disconnect() {this.active = false;}},
        ResizeObserver: class {constructor(fn) {this.fn = fn; this.elements = new Set(); resizes.push(this);} observe(el) {this.elements.add(el);} unobserve(el) {this.elements.delete(el);} disconnect() {this.elements.clear();}},
        chrome: {storage: {local: {get: () => storage, set: async value => {saved.push(value);}}}},
        vivaldiWindowId: 1, vivaldi: {tabsPrivate: {onKeyboardShortcut: {addListener: fn => shortcuts.add(fn), removeListener: fn => shortcuts.delete(fn)}}}
    };
    let instrumented = source.replace('queueMicrotask(initFullscreen);', '');
    for (const [key, value] of Object.entries(options)) instrumented = instrumented.replace(new RegExp('(' + key + ' = )[^,;]+'), '$1' + value);
    vm.runInNewContext(instrumented.replace(/\}\)\(\);\s*$/, 'globalThis.FullscreenMod=FullscreenMod; globalThis.initFullscreen=initFullscreen;})();'), context);
    const f = {elements, events, shortcuts, mutations, resizes, timers, saved, tick, Element, context};
    f.start = () => f.mod = new context.FullscreenMod();
    f.load = async value => {resolveStorage(value === undefined ? {} : {fullScreenModEnabled: value}); await storage; await Promise.resolve();};
    f.failLoad = async () => {rejectStorage(Error('Unavailable')); await storage.catch(() => {}); await Promise.resolve();};
    f.resize = () => resizes.filter(observer => observer.elements.size).forEach(observer => observer.fn());
    f.mutate = mutation => mutations.filter(observer => observer.active).forEach(observer => observer.fn([mutation], observer));
    f.key = (id, combination) => shortcuts.forEach(fn => fn(id, combination));
    return f;
}

test('startup waits for the content container and tolerates missing optional bars', async () => {
    const f = fixture(); f.elements.webview.remove(); f.elements.tabs.remove(); f.elements.footer.remove();
    f.context.initFullscreen(); assert.equal(f.shortcuts.size, 0);
    f.elements.browser.appendChild(f.elements.webview);
    f.mutate({type:'childList', target:f.elements.browser, addedNodes:[f.elements.webview], removedNodes:[]});
    assert.equal(f.shortcuts.size, 1); await f.load();
    assert.equal(f.elements.app.classList.contains('fullscreen-listener-enabled'), true);
});

test('stored disabled state creates no hover areas or active layout observers', async () => {
    const f = fixture(); f.start(); await f.load(false);
    assert.equal(f.elements.app.classList.contains('fullscreen-listener-enabled'), false);
    assert.equal(f.elements.app.querySelector('.hover-div'), null);
    assert.equal(f.resizes.length, 0);
});

test('an early F11 choice wins over a delayed storage read and other windows are ignored', async () => {
    const f = fixture(); const mod = f.start(); f.key(2, 'F11'); assert.equal(mod.stateChanged, false);
    f.key(1, 'F11'); await f.load(true); assert.equal(mod.fullscreenEnabled, false);
    assert.equal(f.saved.length, 1); assert.equal(f.saved[0].fullScreenModEnabled, false);
});

test('failed settings reads retain the default and do not override a user choice', async () => {
    for (const changed of [false, true]) {
        const f = fixture(); const mod = f.start(); if (changed) f.key(1, 'F11'); await f.failLoad();
        assert.equal(Boolean(mod.listenerController), !changed);
    }
});

test('repeated toggles leave no disabled pointer or resize listeners, timers or observers', async () => {
    for (const useTwoLevelTabStack of [false, true]) {
        const f = fixture({useTwoLevelTabStack}); const mod = f.start(); await f.load();
        for (let i=0;i<3;i++) {mod.toggleFullScreen(); mod.toggleFullScreen();}
        mod.toggleFullScreen();
        assert.equal(f.timers.size, 0);
        f.elements.webview.dispatchEvent(new Event('pointerenter')); f.events.dispatchEvent(new Event('resize')); f.tick(1000);
        assert.equal(f.timers.size, 0); assert.equal(f.elements.app.className, '');
        assert.equal(f.resizes.every(observer => observer.elements.size === 0), true);
        assert.equal(f.mutations.every(observer => observer === mod.editObserver || !observer.active), true);
        assert.equal(f.elements.app.querySelector('.hover-div'), null);
    }
});

test('hover cancellation stops every pending show and hide, including rapid re-entry', async () => {
    const f = fixture(); const mod = f.start(); await f.load(); f.tick(250);
    mod.showTop(); mod.showTop(); mod.clearTimeouts(); f.tick(125);
    assert.equal(f.elements.app.classList.contains('hidden-top'), true);
    mod.showTop(); f.tick(125); assert.equal(f.elements.app.classList.contains('hidden-top'), false);
    mod.hide(); mod.hide(); mod.clearHideTimeout(); f.tick(250);
    assert.equal(f.elements.app.classList.contains('hidden-top'), false);
    mod.hide(); mod.hoverDivTop.dispatchEvent(new Event('pointerenter')); f.tick(300);
    assert.equal(f.elements.app.classList.contains('hidden-top'), false);
});

test('disabling cancels pending hover-size updates and removes all hidden classes immediately', async () => {
    const f = fixture({updateHoverDivSize:true}); const mod = f.start(); await f.load();
    mod.showTop(); mod.hide(); f.events.dispatchEvent(new Event('resize')); mod.toggleFullScreen();
    assert.equal(f.timers.size, 0); f.tick(1000); assert.equal(f.elements.app.className, '');
});

test('layout measurements update both heights and sidebar widths without replacing hover areas', async () => {
    const f = fixture(); const mod = f.start(); await f.load(); const hover = mod.hoverDivLeft, style = mod.styleEl;
    f.elements.mainbar.offsetHeight = 70; f.elements.wrapper.offsetWidth = 320; f.elements.panels.offsetWidth = 50;
    f.resize(); f.events.dispatchEvent(new Event('resize')); assert.equal(Boolean(mod.heightsRAF), true); f.tick(16);
    assert.equal(f.elements.app.style['--fs-top-offset'], '100px'); assert.equal(f.elements.app.style['--fs-left-offset'], '370px');
    assert.equal(mod.hoverDivLeft, hover); assert.equal(mod.styleEl, style);
});

test('moving bars reconciles hover edges and CSS while preserving disabled tab hiding', async () => {
    const f = fixture({hideTabs:false}); const mod = f.start(); await f.load();
    f.elements.browser.classList.remove('address-top', 'bookmark-bar-top');
    f.elements.panels.classList.remove('left'); f.elements.panels.classList.add('right');
    f.mutate({type:'attributes', target:f.elements.browser}); f.tick(16);
    assert.equal(mod.hoverDivLeft, undefined); assert.ok(mod.hoverDivRight);
    assert.equal(f.elements.app.style['--fs-right-offset'], '40px');
    assert.ok(mod.styleEl.textContent.includes('translateY(var(--fs-bottom-offset'));
    assert.equal(mod.styleEl.textContent.includes('padding-bottom: -5px'), false);
});

test('no side hover area intercepts input when both panel and tab hiding are disabled', async () => {
    const f = fixture({hideTabs:false,hidePanels:false}); const mod = f.start(); await f.load();
    assert.equal(mod.hoverDivLeft, undefined); assert.equal(mod.hoverDivRight, undefined);
});

test('replacing content and toolbar elements detaches old handlers and observes replacements', async () => {
    const f = fixture(); const mod = f.start(); await f.load(); f.tick(250);
    const old = f.elements.webview; old.remove();
    const replacement = f.elements.browser.appendChild(new f.Element('div','webview-container'));
    f.mutate({type:'childList', target:f.elements.browser, addedNodes:[replacement], removedNodes:[old]}); f.tick(16);
    old.dispatchEvent(new Event('pointerenter')); assert.equal(f.timers.size, 0);
    replacement.dispatchEvent(new Event('pointerenter')); assert.equal(f.timers.size, 1);
    const oldBar = f.elements.mainbar; oldBar.remove(); const bar = f.elements.browser.appendChild(new f.Element('div','','mainbar')); bar.offsetHeight=90;
    f.mutate({type:'childList', target:f.elements.browser, addedNodes:[bar], removedNodes:[oldBar]}); f.tick(16);
    assert.equal(f.resizes[0].elements.has(oldBar), false); assert.equal(f.resizes[0].elements.has(bar), true);
    assert.equal(f.elements.app.style['--fs-main-bar-height'], '90px');
});

test('new second-level tab containers are observed and irrelevant DOM changes are ignored', async () => {
    const f = fixture({useTwoLevelTabStack:true}); const mod = f.start(); await f.load(); f.tick(250);
    const unrelated = new f.Element(); f.mutate({type:'childList', target:f.elements.mainbar, addedNodes:[unrelated], removedNodes:[]});
    assert.equal(mod.heightsRAF, null);
    const sub = f.elements.tabs.appendChild(new f.Element('div','tabs-subcontainer'));
    f.mutate({type:'childList', target:f.elements.tabs, addedNodes:[sub], removedNodes:[]}); f.tick(16);
    assert.equal(f.resizes[0].elements.has(sub), true);
});

test('destroy is idempotent and a late settings result cannot revive the mod', async () => {
    const f = fixture(); const mod = f.start(); mod.destroy(); mod.destroy(); await f.load(true);
    assert.equal(f.shortcuts.size, 0); assert.equal(f.timers.size, 0); assert.equal(mod.listenerController, null);
    const active = fixture(); const running = active.start(); await active.load(); active.events.dispatchEvent(new Event('unload')); active.tick(1000);
    assert.equal(active.shortcuts.size, 0); assert.equal(active.timers.size, 0); assert.equal(running.styleEl.isConnected, false);
    assert.equal(active.mutations.every(observer => !observer.active), true);
});

function editToolbar(f, editing) {
    f.elements.browser.classList[editing ? 'add' : 'remove']('toolbar-edit-mode');
    f.mutate({type:'attributes', target:f.elements.browser});
}

test('toolbar editing immediately cancels hiding and restores the enabled state without saving a preference', async () => {
    const f = fixture(); const mod = f.start(); await f.load(true);
    mod.showTop(); mod.hide(); f.events.dispatchEvent(new Event('resize'));
    editToolbar(f, true);
    assert.equal(mod.fullscreenEnabled, true); assert.equal(mod.listenerController, null);
    assert.equal(f.elements.app.className, ''); assert.equal(f.timers.size, 0);
    f.elements.webview.dispatchEvent(new Event('pointerenter')); f.tick(1000);
    assert.equal(f.elements.app.className, ''); assert.equal(f.elements.app.querySelector('.hover-div'), null);
    editToolbar(f, false); f.tick(250);
    assert.ok(mod.listenerController); assert.equal(f.elements.app.classList.contains('hidden-top'), true);
    assert.equal(f.saved.length, 0);
});

test('editing does not activate a disabled mod or race the initial settings read', async () => {
    for (const enabled of [false, true]) {
        const f = fixture(); const mod = f.start(); editToolbar(f, true);
        assert.equal(mod.listenerController, null); assert.equal(f.resizes.length, 0);
        await f.load(enabled); assert.equal(mod.listenerController, null);
        editToolbar(f, false); assert.equal(Boolean(mod.listenerController), enabled);
        assert.equal(f.saved.length, 0);
    }
});

test('F11 changes made while editing apply only after leaving the editor', async () => {
    for (const enabled of [false, true]) {
        const f = fixture(); const mod = f.start(); await f.load(enabled); editToolbar(f, true);
        f.key(1, 'F11'); assert.equal(mod.fullscreenEnabled, !enabled); assert.equal(mod.listenerController, null);
        f.tick(1000); assert.equal(f.elements.app.className, '');
        editToolbar(f, false); assert.equal(Boolean(mod.listenerController), !enabled);
        assert.equal(f.saved.length, 1); assert.equal(f.saved[0].fullScreenModEnabled, !enabled);
    }
});
