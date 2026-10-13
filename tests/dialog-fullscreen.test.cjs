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
        querySelector: () => [...elements].find(element => element.getAttribute('data-dialog-fullscreen-player') === document.documentElement.getAttribute('data-dialog-fullscreen')) || null,
        createElement: () => new Element()
    };
    const window = new EventTarget();
    window.parent = window;
    const functions = loadDialogFullscreen();
    const install = `(${functions.installController.toString()})();(${functions.installInPage.toString()})();`;
    new vm.Script(install).runInNewContext({
        document, window, Element, Event, CustomEvent: class extends Event { constructor(type, options) { super(type); this.detail = options.detail; } }, console, ShadowRoot: class {},
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
        }}
    };
    const DialogFullscreen = loadDialogFullscreen({chrome});
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
