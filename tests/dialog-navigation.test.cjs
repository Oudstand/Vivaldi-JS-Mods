const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'dialog.js'), 'utf8');

test('input searches use the window default and wait for search-engine initialization', async () => {
    const start = source.indexOf('    class UrlUtils {');
    const end = source.indexOf('    class WebviewLinkInteractionUtils {', start);
    for (const incognito of [false, true]) {
        const calls = [];
        let ready;
        const engines = {incognito, ready: new Promise(resolve => {ready = resolve;})};
        const UrlUtils = vm.runInNewContext(source.slice(start, end) + '\nUrlUtils', {
            URL, window: {incognito}, vivaldi: {searchEngines: {getSearchRequest: async (...args) => {
                calls.push(args); return {url: 'https://search.test/result'};
            }}}
        });
        assert.equal(await UrlUtils.normalizeOrSearch(' https://example.test/ ', engines), 'https://example.test/');
        const pending = UrlUtils.normalizeOrSearch('query', engines);
        assert.deepEqual(calls, []);
        engines.defaultSearchId = 'normal'; engines.privateSearchId = 'private'; ready();
        assert.equal(await pending, 'https://search.test/result');
        assert.deepEqual(calls, [[incognito ? 'private' : 'normal', 'query']]);
    }
});

test('cleanup continues after errors and remains safe when repeated or registered late', () => {
    const start = source.indexOf('    class DialogLifetime {');
    const end = source.indexOf('    class DialogMod {', start);
    const errors = [], calls = [];
    const DialogLifetime = vm.runInNewContext(source.slice(start, end) + '\nDialogLifetime', {
        AbortController, console: {debug: (...args) => errors.push(args)}
    });
    const lifetime = new DialogLifetime();
    lifetime.add(() => {calls.push('first'); throw new Error('First failed');});
    lifetime.add(() => calls.push('second'));
    lifetime.dispose(); lifetime.dispose();
    lifetime.add(() => {calls.push('late'); throw new Error('Late failed');});
    lifetime.add(() => calls.push('last'));
    assert.deepEqual(calls, ['first', 'second', 'late', 'last']);
    assert.equal(errors.length, 2);
    assert.equal(lifetime.signal.aborted, true);
});

function selectionFixture({focusedTab, incognito = false, text = 'selected article text', nativeText = text, frameTexts = [text], tabs = [{id: 202}]} = {}) {
    const queries = [], selections = [], searches = [];
    const start = source.indexOf('        async searchForSelectedText() {');
    const end = source.indexOf('\n        /**', start);
    const search = vm.runInNewContext('({' + source.slice(start, end) + '})', {
        vivaldiWindowId: 22, window: {incognito},
        document: {activeElement: {closest: () => focusedTab === undefined ? null : {
            tab_id: focusedTab, executeScript: (options, callback) => callback(frameTexts)
        }}},
        chrome: {runtime: {}, tabs: {query: async options => {queries.push({...options}); return tabs;}}},
        vivaldi: {utilities: {getSelectedText: async id => {selections.push(id); return nativeText;}}}
    });
    search.getActiveWebview = () => null;
    search.searchEngineUtils = {incognito, defaultSearchId: 'default', privateSearchId: 'private', ready: Promise.resolve()};
    search.dialogTabSearch = (...args) => searches.push(args);
    return {search, queries, selections, searches};
}

test('selection search reads the active tab in the owning window', async () => {
    const fixture = selectionFixture();
    await fixture.search.searchForSelectedText();
    assert.deepEqual(fixture.queries, [{active: true, windowId: 22}]);
    assert.deepEqual(fixture.selections, [202]);
    assert.deepEqual(fixture.searches, [['default', 'selected article text']]);
});

test('selection search uses the focused dialog or panel tab instead of the main tab', async () => {
    const fixture = selectionFixture({focusedTab: '303'});
    await fixture.search.searchForSelectedText();
    assert.deepEqual(fixture.queries, []);
    assert.deepEqual(fixture.selections, [303]);
});

test('private selection search uses the private default engine', async () => {
    const fixture = selectionFixture({incognito: true});
    await fixture.search.searchForSelectedText();
    assert.equal(fixture.searches[0][0], 'private');
});

test('an empty native selection falls back to the focused webview frame, including Reader View', async () => {
    const fixture = selectionFixture({focusedTab: '303', nativeText: '', frameTexts: ['', 'iframe selection']});
    await fixture.search.searchForSelectedText();
    assert.deepEqual(fixture.searches, [['default', 'iframe selection']]);
});

test('selection search tolerates an empty window and ignores empty selection', async () => {
    for (const options of [{tabs: []}, {text: ''}, {text: '  '}]) {
        const fixture = selectionFixture(options);
        await fixture.search.searchForSelectedText();
        assert.deepEqual(fixture.searches, []);
    }
});

test('shortcuts from other windows do not close dialogs or start searches', () => {
    const start = source.indexOf('        keyCombo(id, combination) {');
    const end = source.indexOf('\n        cleanupDialog(', start);
    const shortcuts = vm.runInNewContext('({' + source.slice(start, end) + '})', {vivaldiWindowId: 22});
    let calls = 0;
    shortcuts.KEYBOARD_SHORTCUTS = {Esc: () => calls++};
    shortcuts.keyCombo(11, 'Esc');
    assert.equal(calls, 0);
    shortcuts.keyCombo(22, 'Esc');
    assert.equal(calls, 1);
});

test('completion of an earlier navigation cannot hide a new loading indicator', () => {
    const timers = new Map();
    let nextId = 0;
    const start = source.indexOf('    class ProgressBar {');
    const end = source.indexOf('\n    /**', start);
    const ProgressBar = vm.runInNewContext(source.slice(start, end) + '\nProgressBar', {
        document: {createElement: () => ({style: {}, classList: {add() {}, remove() {}}, setAttribute() {}})},
        requestAnimationFrame: () => ++nextId,
        cancelAnimationFrame() {},
        setTimeout: fn => {const id = ++nextId; timers.set(id, fn); return id;},
        clearTimeout: id => timers.delete(id)
    });
    const advanceTimers = () => {
        const pending = [...timers.values()];
        timers.clear();
        pending.forEach(fn => fn());
    };
    const bar = new ProgressBar('navigation-test');
    bar.start();
    bar.clear(true);
    bar.start();
    advanceTimers();
    assert.equal(bar.element.style.visibility, 'visible');
    bar.clear(true);
    advanceTimers();
    assert.equal(bar.element.style.visibility, 'hidden');
    bar.destroy();
});
