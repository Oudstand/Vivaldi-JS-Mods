const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'dialog.js'), 'utf8');
const classSource = source.slice(source.indexOf('    class SearchEngineUtils {'), source.indexOf('    class ReaderView {'));

function fixture() {
    const clicked = new Set(), changed = new Set(), menus = new Map(), calls = [], errors = [];
    const url = 'chrome-extension://vivaldi/main.html';
    const core = {location: {href: url}, chrome: {runtime: {}}, vivaldi: {}};
    let engines = {defaultSearch: 'normal', defaultPrivate: 'private', templateUrls: [{guid: 'one', name: 'First'}]};
    let failCreate = false;
    const callback = (fn, error) => {
        core.chrome.runtime.lastError = error && {message: error};
        fn();
        delete core.chrome.runtime.lastError;
    };
    core.chrome.contextMenus = {
        onClicked: {addListener: fn => clicked.add(fn)},
        create(properties, fn) {
            calls.push(['create', properties.id]);
            if (failCreate) {failCreate = false; return callback(fn, 'Temporary create failure');}
            if (menus.has(properties.id)) return callback(fn, 'Duplicate ID');
            menus.set(properties.id, {...properties}); callback(fn);
        },
        update(id, properties, fn) {
            calls.push(['update', id]);
            if (!menus.has(id)) return callback(fn, 'Cannot find menu item');
            menus.set(id, {id, ...properties}); callback(fn);
        },
        remove(id, fn) {calls.push(['remove', id]); menus.delete(id); callback(fn);}
    };
    core.vivaldi.searchEngines = {
        getTemplateUrls: async () => engines,
        onTemplateUrlsChanged: {addListener: fn => changed.add(fn)}
    };
    function client(windowId, incognito = false) {
        const window = new EventTarget(); window.incognito = incognito;
        const Class = vm.runInNewContext(classSource + '\nSearchEngineUtils', {
            window, vivaldiWindowId: windowId,
            chrome: {extension: {inIncognitoContext: incognito, getViews: () => [core]}, runtime: {getURL: () => url}},
            console: {debug: (...args) => errors.push(args)}
        });
        const links = [], searches = [];
        const instance = new Class(url => links.push(url), (...args) => searches.push(args), {
            menuPrefix: '[Dialog]', linkMenuTitle: 'Open', searchMenuTitle: 'Search', selectSearchMenuTitle: 'Search with'
        });
        return {instance, window, links, searches};
    }
    return {client, clicked, changed, menus, calls, errors,
        setEngines(value) {engines = value;},
        failCreate() {failCreate = true;},
        refresh() {for (const fn of changed) fn();},
        click(info, windowId) {for (const fn of clicked) fn(info, {windowId});}
    };
}

test('all windows share one set of menus and listeners, with clicks routed to their source window', async () => {
    const f = fixture(), first = f.client(1), second = f.client(2, true);
    await second.instance.ready;
    assert.equal(f.clicked.size, 1);
    assert.equal(f.changed.size, 1);
    assert.equal(f.calls.filter(([method]) => method === 'create').length, 4);
    f.click({menuItemId: 'dialog-tab-link', linkUrl: 'https://example.test/'}, 2);
    assert.deepEqual(first.links, []);
    assert.deepEqual(second.links, ['https://example.test/']);
    f.click({menuItemId: 'search-dialog-tab', selectionText: 'secret'}, 2);
    assert.deepEqual(second.searches, [['private', 'secret']]);
    f.click({menuItemId: 'select-search-dialog-tabone', parentMenuItemId: 'select-search-dialog-tab', selectionText: 'term'}, 1);
    assert.deepEqual(first.searches, [['one', 'term']]);
    assert.deepEqual(f.errors, []);
});

test('closing the first window keeps menus usable in other and subsequently opened windows', async () => {
    const f = fixture(), first = f.client(1), second = f.client(2);
    await first.instance.ready;
    first.window.dispatchEvent(new Event('unload'));
    f.click({menuItemId: 'dialog-tab-link', linkUrl: 'https://example.test/'}, 1);
    assert.deepEqual(first.links, []);
    f.click({menuItemId: 'dialog-tab-link', linkUrl: 'https://example.test/'}, 2);
    assert.equal(second.links.length, 1);
    second.window.dispatchEvent(new Event('unload'));
    const third = f.client(3); await third.instance.ready;
    assert.equal(f.calls.filter(([method]) => method === 'create').length, 4);
    assert.equal(f.clicked.size, 1);
});

test('entries left by an earlier UI instance are adopted without duplicate creation', async () => {
    const f = fixture();
    for (const id of ['dialog-tab-link', 'search-dialog-tab', 'select-search-dialog-tab', 'select-search-dialog-tabone']) {
        f.menus.set(id, {id, title: 'Old title'});
    }
    const first = f.client(1); await first.instance.ready;
    assert.equal(f.calls.filter(([method]) => method === 'create').length, 0);
    assert.equal(f.menus.get('dialog-tab-link').title, '[Dialog] Open');
    assert.deepEqual(f.errors, []);
});

test('engine updates rename, remove and add only the affected shared entries', async () => {
    const f = fixture(), first = f.client(1), second = f.client(2);
    await first.instance.ready;
    f.setEngines({defaultSearch: 'two', defaultPrivate: 'two', templateUrls: [{guid: 'one', name: 'Renamed'}, {guid: 'two', name: 'Second'}]});
    f.refresh(); f.refresh();
    await second.instance.ready;
    assert.equal(f.menus.get('select-search-dialog-tabone').title, 'Renamed');
    assert.equal(second.instance.defaultSearchId, 'two');
    assert.equal(f.calls.filter(([method, id]) => method === 'create' && id === 'select-search-dialog-tabtwo').length, 1);
    f.setEngines({defaultSearch: 'two', defaultPrivate: 'two', templateUrls: [{guid: 'two', name: 'Second'}]});
    f.refresh(); await first.instance.ready;
    assert.equal(f.menus.has('select-search-dialog-tabone'), false);
    assert.deepEqual(f.errors, []);
});

test('a failed menu update can be retried without duplicating successfully created entries', async () => {
    const f = fixture(); f.failCreate();
    const first = f.client(1); await first.instance.ready;
    assert.equal(f.errors.length, 1);
    f.refresh(); await first.instance.ready;
    assert.equal(f.menus.size, 4);
    assert.equal(f.errors.length, 1);
});
