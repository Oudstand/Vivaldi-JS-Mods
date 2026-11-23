const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadDialogFullscreen(globals = {}) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'dialog.js'), 'utf8');
    const start = source.indexOf('    class DialogFullscreen {');
    const end = source.indexOf('    class WebsiteInjectionUtils {', start);
    assert.ok(start >= 0 && end > start);

    return vm.runInNewContext(source.slice(start, end) + '\nDialogFullscreen', globals);
}

// Vivaldi window APIs: a browser window whose state changes are reported to the mod.
function fakeWindow(initialState = 'maximized') {
    let stateListener = null;
    const setStates = [];
    const globals = {
        vivaldiWindowId: 1,
        vivaldi: {windowPrivate: {
            onStateChanged: {addListener: listener => { stateListener = listener; }},
            setState: (windowId, state) => setStates.push(state)
        }}
    };
    const chrome = {windows: {get: (windowId, callback) => callback({state: initialState})}, runtime: {}};
    return {globals, chrome, setStates, changeState: state => stateListener?.(1, state)};
}

function nativeFullscreenSetup(initialState, keepInDialog = true) {
    const window = fakeWindow(initialState);
    const DialogFullscreen = loadDialogFullscreen({...window.globals, chrome: {
        ...window.chrome,
        scripting: {executeScript: options => { injections.push(options); return Promise.resolve(); }},
        webNavigation: {onCommitted: {addListener() {}, removeListener() {}}}
    }});
    const webview = new EventTarget();
    webview.tab_id = '42';
    webview.exits = 0;
    webview.setIsFullscreen = value => { if (!value) webview.exits++; };
    webview.executeScript = (details, callback) => callback([false]);
    const cleanups = [];
    const injections = [];
    const fullscreen = new DialogFullscreen(webview, {signal: new AbortController().signal, add: cleanup => cleanups.push(cleanup)}, keepInDialog);
    const closeDialog = () => cleanups.forEach(cleanup => cleanup());
    const pageFullscreen = enter => {
        const event = new Event('fullscreen');
        event.enterFullscreen = enter;
        webview.dispatchEvent(event);
    };
    return {...window, webview, fullscreen, pageFullscreen, closeDialog, injections};
}

test('native fallback undoes the window fullscreen whether it arrives before or after the page event', () => {
    const before = nativeFullscreenSetup();
    before.changeState('fullscreen');
    before.pageFullscreen(true);
    assert.deepEqual(before.setStates, ['maximized']);

    const after = nativeFullscreenSetup('normal');
    after.pageFullscreen(true);
    after.changeState('fullscreen');
    assert.deepEqual(after.setStates, ['normal']);
});

test('native fallback leaves a window alone that the user made fullscreen', async () => {
    const setup = nativeFullscreenSetup();
    setup.changeState('fullscreen');
    await new Promise(resolve => setTimeout(resolve, 600));
    setup.pageFullscreen(true);
    assert.deepEqual(setup.setStates, []);
    // A later unrelated window change must not be undone either.
    setup.changeState('maximized');
    setup.changeState('fullscreen');
    assert.deepEqual(setup.setStates, []);
});

test('a page fullscreen that already ended or whose dialog closed no longer undoes a later F11', () => {
    const exited = nativeFullscreenSetup('normal');
    exited.pageFullscreen(true);
    exited.pageFullscreen(false);
    exited.changeState('fullscreen');
    assert.deepEqual(exited.setStates, []);

    const closed = nativeFullscreenSetup('normal');
    closed.pageFullscreen(true);
    closed.closeDialog();
    closed.changeState('fullscreen');
    assert.deepEqual(closed.setStates, []);
});

test('without keeping fullscreen in the dialog, Escape still ends page fullscreen first', async () => {
    const setup = nativeFullscreenSetup('normal', false);
    setup.webview.dispatchEvent(new Event('contentload'));
    setup.pageFullscreen(true);
    setup.changeState('fullscreen');
    assert.deepEqual(setup.injections, []);
    assert.deepEqual(setup.setStates, []);
    assert.equal(await setup.fullscreen.exitOnEscape(), true);
    assert.equal(setup.webview.exits, 1);
    setup.pageFullscreen(false);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(await setup.fullscreen.exitOnEscape(), false);
});

test('Escape ends native fallback fullscreen before closing the dialog', async () => {
    const setup = nativeFullscreenSetup();
    setup.pageFullscreen(true);
    assert.equal(await setup.fullscreen.exitOnEscape(), true);
    assert.equal(setup.webview.exits, 1);
    setup.pageFullscreen(false);
    // The same Esc may reach the mod again right after fullscreen ended.
    assert.equal(await setup.fullscreen.exitOnEscape(), true);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(await setup.fullscreen.exitOnEscape(), false);
});

test('dialog fullscreen functions survive script serialization', () => {
    const DialogFullscreen = loadDialogFullscreen();
    // chrome.scripting embeds Function.toString() as a function expression.
    // Playwright's evaluate(function) normalizes method shorthand and would
    // conceal this regression, so compile the actual serialized source.
    for (const func of [DialogFullscreen.installInPage, DialogFullscreen.installController, DialogFullscreen.exitInPage]) {
        const serialized = Function.prototype.toString.call(func);
        const roundTripped = new vm.Script(`(${serialized})`).runInNewContext();
        assert.equal(typeof roundTripped, 'function');
        assert.doesNotThrow(() => new vm.Script(`(${serialized})();`));
    }
    assert.doesNotThrow(() => new vm.Script(DialogFullscreen.EXIT_SCRIPT));
});

test('Escape exits player fullscreen before allowing the dialog to close', () => {
    const script = new vm.Script(loadDialogFullscreen().EXIT_SCRIPT);
    const events = [];
    const attributes = new Map();
    const page = {
        document: {documentElement: {
            hasAttribute: name => attributes.has(name),
            getAttribute: name => attributes.get(name) ?? null
        }},
        window: {dispatchEvent: event => events.push(event.type)},
        Event: class { constructor(type) { this.type = type; } }
    };

    assert.equal(script.runInNewContext(page), false, 'normal page allows closing');
    attributes.set('data-dialog-fullscreen', '');
    assert.equal(script.runInNewContext(page), true, 'active player consumes Escape');
    assert.deepEqual(events, ['dialog-fullscreen-exit']);

    attributes.delete('data-dialog-fullscreen');
    attributes.set('data-dialog-fullscreen-exited', String(Date.now()));
    assert.equal(script.runInNewContext(page), true, 'same Escape reaching the browser must not close the dialog');
    attributes.set('data-dialog-fullscreen-exited', String(Date.now() - 1000));
    assert.equal(script.runInNewContext(page), false, 'a later Escape allows closing');
    assert.equal(events.length, 1, 'inactive player receives no additional exit event');
});

test('Steam can toggle using document.fullscreen instead of fullscreenElement', async () => {
    const elements = new Set();
    class Element extends EventTarget {
        constructor() { super(); elements.add(this); }
        attributes = new Map();
        isConnected = true;
        open = false;
        getAttribute(name) { return this.attributes.get(name) ?? null; }
        setAttribute(name, value) { this.attributes.set(name, value); }
        removeAttribute(name) { this.attributes.delete(name); }
        matches() { return this.open; }
        showPopover() { this.open = true; }
        hidePopover() { this.open = false; }
        append(element) { element.isConnected = true; }
        remove() { this.isConnected = false; }
        getRootNode() { return document; }
    }
    const document = {
        fullscreen: false, fullscreenElement: null,
        documentElement: new Element(),
        querySelectorAll: () => [...elements],
        querySelector: selector => {
            const request = selector.match(/data-dialog-fullscreen-request="([^"]+)"/)?.[1];
            if (request) return [...elements].find(element => element.getAttribute('data-dialog-fullscreen-request') === request) || null;
            return [...elements].find(element => element.getAttribute('data-dialog-fullscreen-player') === document.documentElement.getAttribute('data-dialog-fullscreen')) || null;
        },
        createElement: () => new Element()
    };
    const window = new EventTarget();
    window.parent = window;
    const functions = loadDialogFullscreen();
    const install = `(${functions.installController.toString()})();(${functions.installInPage.toString()})();`;
    new vm.Script(install).runInNewContext({
        document, window, Element, Event, CustomEvent: class extends Event { constructor(type, options) { super(type, options); this.detail = options.detail; } }, console, ShadowRoot: class {}, CSS: {escape: value => value},
        MutationObserver: class { observe() {} disconnect() {} }
    });
    const player = new Element();
    // The current Steam player checks this boolean to choose enter versus exit.
    const toggle = () => document.fullscreen ? document.exitFullscreen() : player.requestFullscreen();
    await toggle();
    assert.equal(document.fullscreen, true);
    assert.equal(document.fullscreenElement, player);
    await toggle();
    assert.equal(document.fullscreen, false);
    assert.equal(document.fullscreenElement, null);
    assert.equal(player.open, false);
});

test('fullscreen injection covers existing frames and later subframe navigations and stops on disposal', async () => {
    const injections = [];
    const listeners = new Set();
    const chrome = {
        scripting: {executeScript: options => { injections.push(options); return Promise.resolve(); }},
        webNavigation: {onCommitted: {
            addListener: listener => listeners.add(listener),
            removeListener: listener => listeners.delete(listener)
        }},
        windows: {get() {}},
        runtime: {}
    };
    const DialogFullscreen = loadDialogFullscreen({chrome, ...fakeWindow().globals});
    const controller = new AbortController();
    const cleanups = [];
    const webview = new EventTarget();
    webview.tab_id = '42';
    new DialogFullscreen(webview, {signal: controller.signal, add: cleanup => cleanups.push(cleanup)});
    webview.dispatchEvent(new Event('contentload'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(injections.length, 2);
    assert.equal(injections[0].target.tabId, 42);
    assert.equal(injections[0].target.allFrames, true);
    assert.equal(injections[0].world, 'ISOLATED');
    assert.equal(injections[1].world, 'MAIN');
    for (const listener of listeners) listener({tabId: 42, frameId: 7});
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(Array.from(injections[2].target.frameIds), [7]);
    for (const listener of listeners) listener({tabId: 99, frameId: 0});
    assert.equal(injections.length, 4);
    controller.abort();
    cleanups.forEach(cleanup => cleanup());
    webview.dispatchEvent(new Event('loadstop'));
    assert.equal(listeners.size, 0);
    assert.equal(injections.length, 4);
});
