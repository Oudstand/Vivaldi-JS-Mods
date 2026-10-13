const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function readerFixture(url, {previousUrl, pendingUrl, tabId = '42', globals = {}} = {}) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'dialog.js'), 'utf8');
    const start = source.indexOf('    class ReaderView {'), end = source.indexOf('    class ProgressBar {', start);
    assert.ok(start >= 0 && end > start);
    const updates = [], reads = [];
    let back = 0;
    const chrome = {tabs: {
        get: async id => { reads.push(id); return {id, url, pendingUrl}; },
        update: async (id, properties) => updates.push({id, ...properties})
    }};
    const ReaderView = vm.runInNewContext(source.slice(start, end) + '\nReaderView', {chrome, URL, URLSearchParams, ...globals});
    const webview = {tab_id: tabId, src: 'https://stale.test/',
        getPageHistory: callback => callback(1, [{url: previousUrl}, {url}]), back: () => back++};
    return {ReaderView, webview, updates, reads, get back() { return back; }};
}

test('reader opens Vivaldi native reader in the existing related tab and preserves the complete article URL', async () => {
    const url = 'https://example.test/article?a=one&b=ä#section';
    const fixture = readerFixture(url);
    await fixture.ReaderView.toggle(fixture.webview);
    assert.deepEqual(fixture.reads, [42]);
    assert.equal(fixture.updates.length, 1);
    assert.equal(fixture.updates[0].id, 42);
    const reader = new URL(fixture.updates[0].url);
    assert.equal(reader.protocol, 'chrome:');
    assert.equal(reader.hostname, 'reader');
    assert.equal(reader.searchParams.get('path'), new URL(url).href);
});

test('turning reader off uses native history to restore the original article', async () => {
    const article = 'https://example.test/article?query=1#section';
    const fixture = readerFixture('chrome://reader/?' + new URLSearchParams({path: article}), {previousUrl: article});
    await fixture.ReaderView.toggle(fixture.webview);
    assert.equal(fixture.back, 1);
    assert.deepEqual(fixture.updates, []);
});

test('reader returns to its current article after navigating away from the original article inside reader', async () => {
    const article = 'https://example.test/next';
    const fixture = readerFixture('chrome://reader/?' + new URLSearchParams({path: article}), {previousUrl: 'https://example.test/first'});
    await fixture.ReaderView.toggle(fixture.webview);
    assert.equal(fixture.back, 0);
    assert.equal(fixture.updates[0].url, article);
});

test('pending reader navigation is recognized when toggling quickly', async () => {
    const article = 'https://example.test/article';
    const fixture = readerFixture(article, {pendingUrl: 'chrome://reader/?' + new URLSearchParams({path: article})});
    await fixture.ReaderView.toggle(fixture.webview);
    assert.equal(fixture.updates[0].url, article);
});

test('unsupported pages and invalid reader targets are left untouched', async () => {
    for (const url of ['chrome://settings/', 'file:///tmp/article.html', 'chrome://reader/', 'chrome://reader/?path=javascript%3Aalert(1)', 'not a URL']) {
        const fixture = readerFixture(url);
        await fixture.ReaderView.toggle(fixture.webview);
        assert.deepEqual(fixture.updates, []);
        assert.equal(fixture.back, 0);
    }
});

test('a missing or invalid related tab ID does not affect another tab', async () => {
    for (const tabId of [undefined, '', '0', '-1', 'abc']) {
        const fixture = readerFixture('https://example.test/article');
        fixture.webview.tab_id = tabId;
        await fixture.ReaderView.toggle(fixture.webview);
        assert.deepEqual(fixture.reads, []);
        assert.deepEqual(fixture.updates, []);
    }
});

test('reader button state recognizes canonical and Vivaldi reader URLs', () => {
    const {ReaderView} = readerFixture('https://example.test/');
    for (const url of ['chrome://reader/', 'chrome://reader?path=x', 'vivaldi://reader/?path=x']) assert.equal(ReaderView.isReaderUrl(url), true);
    for (const url of ['https://reader/', 'chrome://reader-other/', 'https://example.test/?reader=1', undefined]) assert.equal(ReaderView.isReaderUrl(url), false);
});


function nativeControlsFixture() {
    // Model the native API boundary, leaving reader rendering and adjustments to Vivaldi.
    function NativeReader() { return 'reader-settings-toggle'; }
    const type = {type: NativeReader}, nativePage = {id: 7, windowId: 3, url: 'https://original.test/'};
    class PageStore { getPageById(id) { if (id === 7) return nativePage; } }
    const pages = new PageStore(), lookup = pages.getPageById, calls = [], listeners = new Set(), roots = [], errors = [];
    let failAction = false;
    const api = {setReaderModeStyle(windowId, pageId, patch) {
        const page = pages.getPageById(pageId);
        calls.push({windowId, pageId, patch, page});
        if (failAction) throw new Error('Native action failed');
        return page;
    }};
    const original = api.setReaderModeStyle;
    const themes = {getReaderThemeColor() {}, addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn)};
    const React = {createElement: (type, props, children) => ({type, props: {...props, children}})};
    const ReactDOM = {createRoot(container) {
        const root = {container, render(element) { this.element = element; }, unmount() { this.unmounted = true; }};
        roots.push(root); return root;
    }};
    const modules = {'10': React, '20': ReactDOM, '30': {Z: api}, '31': {ZP: pages}, '32': {Z: themes}};
    const requireNative = id => modules[id];
    requireNative.m = {
        '10': function (exports) { exports.createElement=function () {}; },
        '20': function (exports) { exports.createRoot=function () {}; },
        '30': function (e, t, n) { const pages=n(31),themes=n(32); return {setReaderModeStyle: pages, themes}; },
        '31': function () {}, '32': function () {}
    };
    const core = {webpackChunkgapp_browser_react: {push: chunk => chunk[2](requireNative)}};
    let chunkId = 0;
    function makeWindow(windowId) {
        const window = new EventTarget(); window.vivaldiWindowId = windowId;
        class PageView {
            static contextType = {Provider: Symbol('native.window')};
            props = {id: 7, url: nativePage.url, prefValues: {nativeOption: true}};
            state = {dockingState: 'right'};
            context = window;
            render() {
                return {type: 'div', props: {className: 'webpageview', children:
                    this.props.prefValues['vivaldi.webpages.reader.controls'] &&
                    {type, props: {pageId: this.props.id, inSettings: false}}}};
            }
        }
        const view = new PageView(), props = view.props, state = view.state;
        const node = {__reactFiber$test: {stateNode: view, return: {stateNode: {containerInfo: {ownerDocument: {defaultView: core}}}, return: null}}};
        const document = {createElement: () => ({}), querySelectorAll: () => [node]};
        const {ReaderView} = readerFixture('https://example.test/', {globals: {document, window,
            crypto: {randomUUID: () => String(++chunkId)}, console: {debug: (...args) => errors.push(args)}}});
        function controls(tabId = '42') {
            const webview = new EventTarget(), controller = new AbortController();
            webview.tab_id = tabId; webview.src = 'https://example.test/';
            const root = ReaderView.createControls(webview, controller.signal);
            const navigate = (url, isTopLevel = true) => {
                if (isTopLevel) webview.src = url;
                webview.dispatchEvent(Object.assign(new Event('loadcommit'), {url, isTopLevel}));
            };
            return {webview, controller, root, navigate};
        }
        return {ReaderView, view, props, state, node, window, controls};
    }
    return {...makeWindow(3), makeWindow, core, api, original, pages, lookup, themes, nativePage, type, roots, calls, listeners, errors, requireNative,
        failAction: () => { failAction = true; }};
}

test('reader uses the original component and renderer with native window and related-tab context', () => {
    const fixture = nativeControlsFixture(), controls = fixture.controls();
    assert.equal(controls.root.hidden, true);
    assert.equal(fixture.roots.length, 0);
    controls.navigate('chrome://reader/?path=https%3A%2F%2Fexample.test%2F');
    assert.equal(controls.root.hidden, false);
    const renderer = fixture.roots[0], provider = renderer.element, element = provider.props.children;
    assert.equal(renderer.container, controls.root);
    assert.equal(provider.type, fixture.view.constructor.contextType.Provider);
    assert.equal(provider.props.value, fixture.window);
    assert.equal(element.type, fixture.type);
    assert.equal(element.props.pageId, 42);
    assert.equal(element.props.inSettings, false);
    assert.equal(fixture.view.props, fixture.props);
    assert.equal(fixture.view.state, fixture.state);
    assert.equal(fixture.view.state.dockingState, 'right');
    assert.equal(fixture.calls[0].page.id, 42);
    assert.equal(fixture.calls[0].page.url, controls.webview.src);
    assert.equal(fixture.pages.getPageById, fixture.lookup);
    assert.equal(Object.hasOwn(fixture.pages, 'getPageById'), false);
    assert.equal(fixture.pages.getPageById(42), undefined, 'dialog tabs must not be added to the native page store');
    assert.equal(fixture.errors.length, 0);
    controls.controller.abort();
});

test('native roots ignore subframes, persist through reader navigation and unmount on leaving reader', () => {
    const fixture = nativeControlsFixture(), controls = fixture.controls();
    controls.navigate('chrome://reader/');
    const renderer = fixture.roots[0];
    controls.navigate('https://example.test/iframe', false);
    assert.equal(controls.root.hidden, false);
    controls.navigate('chrome://reader/?path=https%3A%2F%2Fexample.test%2Fnext');
    assert.equal(fixture.roots.length, 1);
    assert.equal(renderer.unmounted, undefined);
    controls.navigate('https://example.test/');
    assert.equal(controls.root.hidden, true);
    assert.equal(renderer.unmounted, true);
    assert.equal(fixture.api.setReaderModeStyle, fixture.original);
    assert.equal(fixture.listeners.size, 0);
    controls.navigate('vivaldi://reader/');
    assert.equal(fixture.roots.length, 2);
    assert.equal(fixture.listeners.size, 1);
    controls.controller.abort();
    assert.equal(fixture.roots[1].unmounted, true);
    controls.navigate('chrome://reader/');
    assert.equal(fixture.roots.length, 2, 'disposed dialogs must not mount again');
});

test('native reader calls for normal pages remain unchanged and theme changes use native actions', () => {
    const fixture = nativeControlsFixture(), first = fixture.controls('42'), second = fixture.controls('43');
    first.navigate('chrome://reader/'); second.navigate('chrome://reader/');
    const patch = {themeStyle: 'theme'};
    assert.equal(fixture.api.setReaderModeStyle(3, 7, patch), fixture.nativePage);
    assert.equal(fixture.calls.at(-1).patch, patch);
    assert.equal(fixture.pages.getPageById, fixture.lookup);
    fixture.calls.length = 0;
    fixture.listeners.forEach(listener => listener());
    assert.deepEqual(fixture.calls.map(call => call.pageId), [42, 43]);
    assert.ok(fixture.calls.every(call => call.page.url.startsWith('chrome://reader/')));
    first.controller.abort();
    assert.equal(fixture.listeners.size, 1);
    assert.notEqual(fixture.api.setReaderModeStyle, fixture.original);
    second.controller.abort();
    assert.equal(fixture.listeners.size, 0);
    assert.equal(fixture.api.setReaderModeStyle, fixture.original);
});

test('different Vivaldi windows share the native action adapter and clean up independently', () => {
    const fixture = nativeControlsFixture(), secondWindow = fixture.makeWindow(4);
    const first = fixture.controls('42'), second = secondWindow.controls('43');
    first.navigate('chrome://reader/');
    const apply = fixture.api.setReaderModeStyle;
    second.navigate('chrome://reader/');
    assert.equal(fixture.api.setReaderModeStyle, apply);
    assert.equal(fixture.listeners.size, 1);
    assert.deepEqual(fixture.calls.map(call => [call.windowId, call.pageId]), [[3, 42], [4, 43]]);
    fixture.window.dispatchEvent(new Event('unload'));
    assert.equal(fixture.roots[0].unmounted, true);
    assert.equal(fixture.roots[1].unmounted, undefined);
    assert.equal(fixture.api.setReaderModeStyle, apply);
    second.controller.abort();
    assert.equal(fixture.roots[1].unmounted, true);
    assert.equal(fixture.api.setReaderModeStyle, fixture.original);
});

test('a native reader action failure restores the page lookup, unmounts and removes the adapter', () => {
    const fixture = nativeControlsFixture(), controls = fixture.controls();
    fixture.failAction(); controls.navigate('chrome://reader/');
    assert.equal(fixture.pages.getPageById, fixture.lookup);
    assert.equal(Object.hasOwn(fixture.pages, 'getPageById'), false);
    assert.equal(fixture.roots[0].unmounted, true);
    assert.equal(fixture.api.setReaderModeStyle, fixture.original);
    assert.equal(fixture.listeners.size, 0);
    assert.equal(fixture.errors.length, 1);
    controls.controller.abort();
});

test('an unsupported Vivaldi component leaves native APIs unchanged and reports the unavailable integration', () => {
    const fixture = nativeControlsFixture(), controls = fixture.controls();
    fixture.node.__reactFiber$test = null;
    controls.navigate('chrome://reader/');
    assert.equal(fixture.api.setReaderModeStyle, fixture.original);
    assert.equal(fixture.roots.length, 0);
    assert.equal(fixture.errors.length, 1);
    controls.controller.abort();
});

test('native React interfaces are checked before setting up reader actions', () => {
    for (const [moduleId, method] of [['10', 'createElement'], ['20', 'createRoot']]) {
        const fixture = nativeControlsFixture(), controls = fixture.controls();
        fixture.requireNative(moduleId)[method] = undefined;
        assert.throws(() => fixture.ReaderView.getNativeControls(controls.webview), /renderer unavailable/);
        assert.equal(fixture.api.setReaderModeStyle, fixture.original);
        assert.equal(fixture.listeners.size, 0);
        controls.controller.abort();
    }
});

test('missing theme listener interfaces are rejected before changing the native reader function', () => {
    for (const method of ['addListener', 'removeListener']) {
        const fixture = nativeControlsFixture(), controls = fixture.controls();
        fixture.themes[method] = undefined;
        let writes = 0;
        Object.defineProperty(fixture.api, 'setReaderModeStyle', {
            get: () => fixture.original, set: () => { writes++; }
        });
        const native = fixture.ReaderView.getNativeControls(controls.webview);
        assert.throws(() => fixture.ReaderView.getNativeActions(native), /context unavailable/);
        assert.equal(writes, 0);
        assert.equal(fixture.listeners.size, 0);
        controls.controller.abort();
    }
});

test('theme registration failures roll back all changes and allow a later retry', () => {
    for (const partiallyRegistered of [false, true]) {
        const fixture = nativeControlsFixture(), controls = fixture.controls();
        const addListener = fixture.themes.addListener;
        fixture.themes.addListener = listener => {
            if (partiallyRegistered) addListener(listener);
            throw new Error('Theme registration failed');
        };
        controls.navigate('chrome://reader/');
        assert.equal(fixture.api.setReaderModeStyle, fixture.original);
        assert.equal(fixture.listeners.size, 0);
        assert.equal(Object.hasOwn(fixture.core, Symbol.for('dialog.mod.nativeReaderActions')), false);
        assert.equal(fixture.roots.length, 0);
        assert.equal(fixture.errors.length, 1);
        fixture.themes.addListener = addListener;
        controls.navigate('chrome://reader/');
        assert.equal(fixture.roots.length, 1);
        assert.equal(fixture.listeners.size, 1);
        controls.controller.abort();
        assert.equal(fixture.api.setReaderModeStyle, fixture.original);
        assert.equal(fixture.listeners.size, 0);
    }
});

test('a failure publishing the shared adapter removes its theme listener and restores the native function', () => {
    const fixture = nativeControlsFixture(), controls = fixture.controls();
    Object.preventExtensions(fixture.core);
    controls.navigate('chrome://reader/');
    assert.equal(fixture.api.setReaderModeStyle, fixture.original);
    assert.equal(fixture.listeners.size, 0);
    assert.equal(fixture.roots.length, 0);
    assert.equal(fixture.errors.length, 1);
    controls.controller.abort();
});

test('rollback restores the native function even if removing a partially registered listener throws', () => {
    const fixture = nativeControlsFixture(), controls = fixture.controls();
    const {addListener, removeListener} = fixture.themes;
    fixture.themes.addListener = listener => { addListener(listener); throw new Error('Registration failed'); };
    fixture.themes.removeListener = listener => { removeListener(listener); throw new Error('Removal failed'); };
    controls.navigate('chrome://reader/');
    assert.equal(fixture.api.setReaderModeStyle, fixture.original);
    assert.equal(fixture.listeners.size, 0);
    assert.equal(Object.hasOwn(fixture.core, Symbol.for('dialog.mod.nativeReaderActions')), false);
    assert.equal(fixture.errors.length, 1);
    controls.controller.abort();
});

test('cleanup preserves a native action wrapper installed later by another mod', () => {
    const fixture = nativeControlsFixture(), controls = fixture.controls();
    controls.navigate('chrome://reader/');
    const apply = fixture.api.setReaderModeStyle;
    const another = function (...args) { return apply.apply(this, args); };
    fixture.api.setReaderModeStyle = another;
    controls.controller.abort();
    assert.equal(fixture.api.setReaderModeStyle, another);
    assert.equal(fixture.api.setReaderModeStyle(3, 7), fixture.nativePage);
});
