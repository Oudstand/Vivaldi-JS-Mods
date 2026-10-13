const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadDialogFullscreen() {
    const source = fs.readFileSync(path.join(__dirname, '..', 'dialog.js'), 'utf8');
    const start = source.indexOf('    class DialogFullscreen {');
    const end = source.indexOf('    class WebsiteInjectionUtils {', start);
    assert.ok(start >= 0 && end > start);

    return vm.runInNewContext(source.slice(start, end) + '\nDialogFullscreen');
}

test('dialog fullscreen functions survive script serialization', () => {
    const DialogFullscreen = loadDialogFullscreen();
    // chrome.scripting embeds Function.toString() as a function expression.
    // Playwright's evaluate(function) normalizes method shorthand and would
    // conceal this regression, so compile the actual serialized source.
    for (const func of [DialogFullscreen.installInPage, DialogFullscreen.exitInPage]) {
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
    class Element extends EventTarget {
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
    }
    const document = {
        fullscreen: false, fullscreenElement: null,
        documentElement: new Element(),
        createElement: () => ({isConnected: false})
    };
    const window = new EventTarget();
    const install = loadDialogFullscreen().installInPage;
    new vm.Script(`(${install.toString()})();`).runInNewContext({document, window, Element, Event, console});
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
