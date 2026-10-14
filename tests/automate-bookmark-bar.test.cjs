const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../automate-bookmark-bar.js'), 'utf8');

function fixture() {
    const ui = new EventTarget(), documentEvents = new EventTarget(), children = new Set();
    let enabled = true;
    const bar = {
        isConnected: true, hidden: false,
        matches: () => enabled,
        setAttribute() {this.hidden = true;},
        removeAttribute() {this.hidden = false;}
    };
    const document = {
        addEventListener: documentEvents.addEventListener.bind(documentEvents),
        getElementById: () => ({append(node) {node.isConnected = true; children.add(node);}}),
        querySelectorAll: () => bar.hidden ? [bar] : [],
        createElement: () => Object.assign(new EventTarget(), {
            style: {}, isConnected: false, attributes: {},
            setAttribute(name, value) {this.attributes[name] = value;},
            remove() {this.isConnected = false; children.delete(this);}
        })
    };
    const context = {
        window: {}, document, AbortController,
        addEventListener: ui.addEventListener.bind(ui),
        removeEventListener: ui.removeEventListener.bind(ui)
    };
    vm.createContext(context);
    const reload = () => vm.runInContext(source, context);
    reload();
    const move = (overBar = true) => {
        const event = new Event('pointermove');
        Object.defineProperty(event, 'target', {value: {closest: () => overBar ? bar : null}});
        documentEvents.dispatchEvent(event);
    };
    const enterPage = () => [...children].forEach(node => node.dispatchEvent(new Event('pointerenter')));
    return {ui, documentEvents, bar, children, move, enterPage, reload, setEnabled: value => enabled = value};
}

test('entering the content hides stale hover and removes the temporary UI surface', () => {
    const f = fixture();
    f.move();
    const sensor = [...f.children][0];
    assert.equal(sensor.attributes['aria-hidden'], 'true');
    for (let i = 0; i < 20; i++) f.move();
    assert.deepEqual([...f.children], [sensor]);
    f.enterPage();
    assert.equal(f.bar.hidden, true);
    assert.equal(f.children.size, 0);
    f.move();
    assert.equal(f.bar.hidden, false);
    f.enterPage();
    assert.equal(f.bar.hidden, true);
});

test('other UI elements and native dragging remove the temporary surface', () => {
    const f = fixture();
    f.move(); f.move(false);
    assert.equal(f.children.size, 0);
    f.move(); f.documentEvents.dispatchEvent(new Event('dragstart'));
    assert.equal(f.children.size, 0);
    assert.equal(f.bar.hidden, false);
});

test('disabled mode, fullscreen and the editor do not arm the helper', () => {
    const f = fixture();
    f.setEnabled(false); f.move();
    assert.equal(f.children.size, 0);
    f.setEnabled(true); f.move();
    f.setEnabled(false); f.enterPage();
    assert.equal(f.children.size, 0);
    assert.equal(f.bar.hidden, false);
});

test('unload clears the surface, listeners and visibility override', () => {
    const f = fixture();
    f.move(); f.enterPage(); f.move();
    f.ui.dispatchEvent(new Event('unload'));
    assert.equal(f.children.size, 0);
    assert.equal(f.bar.hidden, false);
    f.move();
    assert.equal(f.children.size, 0);
});

test('reloading the helper replaces its listeners and temporary surface', () => {
    const f = fixture();
    f.move();
    const previous = [...f.children][0];
    f.reload();
    assert.equal(previous.isConnected, false);
    f.move();
    assert.equal(f.children.size, 1);
    f.enterPage();
    assert.equal(f.bar.hidden, true);
    assert.equal(f.children.size, 0);
});
