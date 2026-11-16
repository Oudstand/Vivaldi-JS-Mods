const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../media-focus.js'), 'utf8');

// No browser: tabs, pages and timers are simulated. Like Vivaldi, a tab only
// reports "not audible" after it went quiet, so tests send that event explicitly.
function fixture() {
    const listeners = {}, timers = new Map(), pages = new Map();
    let nextTimer = 1, now = 1000;
    class Clock extends Date { static now() { return now; } }
    const event = name => ({
        addListener: fn => { listeners[name] = fn; },
        removeListener: fn => { if (listeners[name] === fn) delete listeners[name]; }
    });
    const context = vm.createContext({window: {}, console, crypto, Date: Clock,
        document: {
            addEventListener(type, fn, capture) { assert.equal(capture, true); listeners[type] = fn; },
            removeEventListener(type, fn) { if (listeners[type] === fn) delete listeners[type]; }
        },
        chrome: {
            tabs: {
                onRemoved: event('removed'),
                get: id => pages.has(id) ? Promise.resolve({id, mutedInfo: {muted: pages.get(id).muted}}) : Promise.reject(Error('No tab')),
                query: () => Promise.resolve([...pages.keys()].map(id => ({id})))
            },
            webNavigation: {onCommitted: event('committed')},
            scripting: {executeScript({target, func, args, world}) {
                assert.equal(world, 'MAIN');
                const page = pages.get(target.tabId);
                if (!page) return Promise.reject(Error('No tab'));
                // Like Chrome, only the function's source and JSON arguments reach the page.
                const result = vm.runInContext(`(${func})(...${JSON.stringify(args)})`, page.context);
                return Promise.resolve([{frameId: 0, result}, ...page.subframes]);
            }}
        },
        setTimeout: (fn, ms, ...args) => { timers.set(nextTimer, {fn, due: now + ms, args}); return nextTimer++; },
        clearTimeout: id => timers.delete(id)
    });
    const flush = () => new Promise(resolve => setImmediate(resolve));

    function page(id) {
        class MediaSession {
            playbackState = 'none'; handlers = new Map();
            setActionHandler(action, handler) { this.handlers.set(action, handler); }
        }
        const session = new MediaSession(), media = [];
        const pageContext = vm.createContext({MediaSession, Date: Clock, navigator: {mediaSession: session},
            document: {querySelectorAll: () => media}});
        pageContext.window = pageContext;
        const tab = {id, media, session, muted: false, context: pageContext, subframes: [],
            webview: {localName: 'webview', tab_id: String(id)}};
        pages.set(id, tab);
        listeners.committed?.({tabId: id, frameId: 0});
        return tab;
    }
    // YouTube-like: one HTML media element in the DOM, no Media Session handlers.
    function tab(id) {
        const view = page(id), element = {paused: true, ended: false, muted: false, volume: 1, isConnected: true,
            play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; }};
        view.media.push(element);
        return Object.defineProperties(view, {
            start: {value: () => element.play()}, stop: {value: () => element.pause()},
            playing: {get: () => !element.paused}
        });
    }
    // Spotify-like: the audio element is outside the DOM; play/pause only through Media Session
    // handlers. Like the real Spotify web player, playbackState stays 'none' unless reportsState.
    function spotify(id, {registerHandlers = true, reportsState = false} = {}) {
        const view = page(id), player = {playing: false};
        const set = playing => {
            player.playing = playing;
            if (reportsState) view.session.playbackState = playing ? 'playing' : 'paused';
        };
        view.calls = [];
        view.register = () => {
            vm.runInContext(`navigator.mediaSession.setActionHandler('play', () => { set(true); calls.push('play'); });
                navigator.mediaSession.setActionHandler('pause', () => { set(false); calls.push('pause'); });`,
            Object.assign(view.context, {calls: view.calls, set}));
        };
        if (registerHandlers) view.register();
        return Object.defineProperties(view, {
            start: {value: () => set(true)}, stop: {value: () => set(false)},
            playing: {get: () => player.playing}
        });
    }

    const audible = async (view, value = true) => { listeners.audiostatechanged?.({target: view.webview, audible: value}); await flush(); };
    const play = async view => { view.start(); await audible(view); };
    const stop = async view => { view.stop(); await audible(view, false); };
    const close = async view => { pages.delete(view.id); listeners.removed?.(view.id); await flush(); };
    const tick = async (ms = 3000) => {
        now += ms;
        for (const [id, timer] of [...timers]) {
            if (timer.due <= now) { timers.delete(id); timer.fn(...timer.args); }
        }
        await flush();
    };
    return {tab, spotify, audible, play, stop, close, tick, flush, listeners, timers,
        start: () => vm.runInContext(source, context), context};
}

// Delay one actual page execution, not just its response, to expose command races.
function delayCall(f, matches) {
    const execute = f.context.chrome.scripting.executeScript;
    let release;
    f.context.chrome.scripting.executeScript = request => {
        if (!release && matches(request)) {
            return new Promise(resolve => { release = result => resolve(result ?? execute(request)); });
        }
        return execute(request);
    };
    return async result => { assert.ok(release, 'Expected a pending page call'); release(result); await f.flush(); };
}

test('A → B → A: B pausing restores A', async () => {
    const f = fixture(); f.start();
    const a = f.tab(1), b = f.tab(2);
    await f.play(a); await f.play(b);
    assert.equal(a.playing, false); assert.equal(b.playing, true);
    await f.stop(b);
    assert.equal(a.playing, true);
});

test('Spotify is paused and resumed through its Media Session handlers', async () => {
    const f = fixture(); f.start();
    const music = f.spotify(1), video = f.tab(2);
    await f.play(music); await f.play(video);
    assert.equal(music.playing, false);
    await f.stop(video);
    assert.equal(music.playing, true);
    assert.deepEqual(music.calls, ['pause', 'play']);
});

test('handlers of pages opened before the mod are picked up when re-registered', async () => {
    const f = fixture();
    const music = f.spotify(1, {registerHandlers: false}), video = f.tab(2);
    f.start(); await f.flush();
    music.register(); // Spotify registers its handlers again on every player state change.
    await f.play(music); await f.play(video);
    assert.deepEqual(music.calls, ['pause']);
});

test('Spotify without reported state also works as the interrupting tab', async () => {
    const f = fixture(); f.start();
    const video = f.tab(1), music = f.spotify(2);
    await f.play(video); await f.play(music);
    assert.equal(video.playing, false);
    await f.stop(music);
    assert.equal(video.playing, false, 'waits, as this may just be a track change');
    await f.tick();
    assert.equal(video.playing, true);
});

test('a short gap without reported state (track change) does not resume A', async () => {
    const f = fixture(); f.start();
    const video = f.tab(1), music = f.spotify(2);
    await f.play(video); await f.play(music);
    await f.audible(music, false); await f.audible(music, true);
    await f.tick();
    assert.equal(video.playing, false);
});

test('a player that reports being paused meanwhile is not started again', async () => {
    const f = fixture(); f.start();
    const music = f.spotify(1, {reportsState: true}), video = f.tab(2);
    await f.play(music);
    music.stop(); // Still reported audible for a moment.
    await f.play(video); await f.stop(video);
    assert.equal(music.playing, false); assert.deepEqual(music.calls, []);
});

test('ending or closing B restores A', async () => {
    for (const end of ['stop', 'close']) {
        const f = fixture(); f.start();
        const a = f.tab(1), b = f.tab(2);
        await f.play(a); await f.play(b);
        await f[end](b);
        assert.equal(a.playing, true);
    }
});

test('silence is not a stop; pausing during silence is noticed on the next check', async () => {
    const f = fixture(); f.start();
    const a = f.tab(1), b = f.tab(2);
    await f.play(a); await f.play(b);
    await f.audible(b, false); await f.tick();
    assert.equal(a.playing, false);
    b.stop(); await f.tick();
    assert.equal(a.playing, true);
});

test('B becoming audible again ends the silence checks', async () => {
    const f = fixture(); f.start();
    const a = f.tab(1), b = f.tab(2);
    await f.play(a); await f.play(b);
    await f.audible(b, false); await f.audible(b, true);
    b.stop(); await f.tick();
    assert.equal(a.playing, false);
});

test('manually paused A is not restarted', async () => {
    const f = fixture(); f.start();
    const a = f.tab(1), b = f.tab(2);
    await f.play(a); await f.stop(a);
    await f.play(b); await f.stop(b);
    assert.equal(a.playing, false);
});

test('only one interrupted tab is remembered', async () => {
    const f = fixture(); f.start();
    const a = f.tab(1), b = f.tab(2), c = f.tab(3);
    await f.play(a); await f.play(b); await f.play(c);
    await f.stop(c);
    assert.equal(b.playing, true); assert.equal(a.playing, false);
    await f.stop(b);
    assert.equal(a.playing, false);
});

test('closing the interrupted tab forgets it', async () => {
    const f = fixture(); f.start();
    const a = f.tab(1), b = f.tab(2);
    await f.play(a); await f.play(b); await f.close(a);
    await f.stop(b);
    assert.equal(a.playing, false);
});

test('muted tabs and sound without a playing player do not interrupt A', async () => {
    const f = fixture(); f.start();
    const a = f.tab(1), b = f.tab(2), c = f.tab(3);
    await f.play(a);
    b.muted = true; await f.play(b);
    await f.audible(c); // e.g. a notification sound via Web Audio
    assert.equal(a.playing, true);
});

test('destroy removes all listeners', async () => {
    const f = fixture(); f.start();
    const a = f.tab(1), b = f.tab(2);
    await f.play(a);
    f.context.window.mediaFocus.destroy();
    assert.deepEqual(Object.keys(f.listeners), []);
    await f.play(b);
    assert.equal(a.playing, true);
});

test('running the mod again replaces the previous instance', async () => {
    const f = fixture();
    f.start(); const first = f.listeners.audiostatechanged;
    f.start();
    assert.notEqual(f.listeners.audiostatechanged, first);
    assert.deepEqual(Object.keys(f.listeners).sort(), ['audiostatechanged', 'committed', 'removed']);
});

test('a delayed pause completes before a quick stop resumes the previous tab', async () => {
    const f = fixture(); f.start();
    const a = f.tab(1), b = f.tab(2);
    await f.play(a);
    const release = delayCall(f, r => r.target.tabId === 1 && r.func.name === 'pageSetPaused' && r.args[0]);
    await f.play(b); await f.stop(b);
    await release();
    assert.equal(a.playing, true);
    assert.equal(b.playing, false);
});

test('destroy during a start query prevents a subsequent pause', async () => {
    const f = fixture(); f.start();
    const a = f.tab(1), b = f.tab(2);
    await f.play(a);
    const release = delayCall(f, r => r.target.tabId === 2 && r.func.name === 'pagePlayState');
    await f.play(b);
    f.context.window.mediaFocus.destroy();
    await release();
    assert.equal(a.playing, true);
    assert.equal(f.timers.size, 0);
});

test('destroy during a stop query prevents resuming or scheduling another check', async () => {
    for (const playing of [false, true]) {
        const f = fixture(); f.start();
        const a = f.tab(1), b = f.tab(2);
        await f.play(a); await f.play(b);
        const release = delayCall(f, r => r.target.tabId === 2 && r.func.name === 'pagePlayState');
        if (!playing) b.stop();
        await f.audible(b, false);
        f.context.window.mediaFocus.destroy();
        await release();
        assert.equal(a.playing, false);
        assert.equal(f.timers.size, 0);
    }
});

test('a newer audible event invalidates a pending stop result', async () => {
    const f = fixture(); f.start();
    const a = f.tab(1), b = f.tab(2);
    await f.play(a); await f.play(b);
    const release = delayCall(f, r => r.target.tabId === 2 && r.func.name === 'pagePlayState');
    await f.stop(b); await f.play(b);
    await release([{frameId: 0, result: 'paused'}]);
    assert.equal(a.playing, false);
    assert.equal(f.timers.size, 0);
});

test('a newer stop invalidates a pending start result', async () => {
    const f = fixture(); f.start();
    const a = f.tab(1), b = f.tab(2);
    await f.play(a);
    const release = delayCall(f, r => r.target.tabId === 2 && r.func.name === 'pagePlayState');
    await f.play(b); await f.stop(b);
    let pauses = 0;
    a.media[0].pause = () => { pauses++; a.media[0].paused = true; };
    await release([{frameId: 0, result: 'playing'}]);
    assert.equal(pauses, 0);
    assert.equal(a.playing, true);
});

test('failed queries or a missing main frame do not resume immediately; a successful retry does', async () => {
    for (const result of [null, [], [{frameId: 0}], [{frameId: 3, result: 'paused'}]]) {
        const f = fixture(); f.start();
        const a = f.tab(1), b = f.tab(2);
        await f.play(a); await f.play(b);
        const execute = f.context.chrome.scripting.executeScript;
        f.context.chrome.scripting.executeScript = r => r.func.name === 'pagePlayState'
            ? result === null ? Promise.reject(Error('Unavailable')) : Promise.resolve(result)
            : execute(r);
        await f.stop(b);
        assert.equal(a.playing, false);
        f.context.chrome.scripting.executeScript = execute;
        await f.tick();
        assert.equal(a.playing, true);
    }
});

test('a subframe without result (sandbox without scripts) does not block resuming', async () => {
    const f = fixture(); f.start();
    const a = f.tab(1), b = f.tab(2);
    b.subframes.push({frameId: 10, result: null});
    await f.play(a); await f.play(b);
    await f.stop(b);
    assert.equal(a.playing, true);
});

test('a tab that stays silent and unqueryable counts as stopped after one wait', async () => {
    const f = fixture(); f.start();
    const a = f.tab(1), b = f.tab(2);
    await f.play(a); await f.play(b);
    const execute = f.context.chrome.scripting.executeScript;
    let queries = 0;
    f.context.chrome.scripting.executeScript = r => {
        if (r.func.name !== 'pagePlayState') return execute(r);
        queries++;
        return Promise.reject(Error('Unavailable'));
    };
    await f.stop(b);
    assert.equal(a.playing, false);
    await f.tick();
    assert.equal(queries, 2);
    assert.equal(a.playing, true);
    assert.equal(f.timers.size, 0);
});

test('an audible tab whose query fails still interrupts A', async () => {
    const f = fixture(); f.start();
    const a = f.tab(1), b = f.tab(2);
    await f.play(a);
    const execute = f.context.chrome.scripting.executeScript;
    f.context.chrome.scripting.executeScript = r => r.func.name === 'pagePlayState' && r.target.tabId === 2
        ? Promise.reject(Error('Unavailable')) : execute(r);
    await f.play(b);
    assert.equal(a.playing, false);
});

test('muted decorative media is neither paused nor resumed', async () => {
    const f = fixture(); f.start();
    const a = f.tab(1), b = f.tab(2);
    const loop = {paused: false, ended: false, muted: true, volume: 1, isConnected: true, calls: [],
        play() { this.calls.push('play'); return Promise.resolve(); }, pause() { this.calls.push('pause'); }};
    a.media.push(loop);
    await f.play(a); await f.play(b); await f.stop(b);
    assert.equal(a.playing, true);
    assert.deepEqual(loop.calls, []);
});

test('a pause that executes after its timeout cannot stop resumed playback', async () => {
    const f = fixture(); f.start();
    const a = f.tab(1), b = f.tab(2);
    await f.play(a);
    const release = delayCall(f, r => r.target.tabId === 1 && r.func.name === 'pageSetPaused' && r.args[0]);
    await f.play(b); await f.tick(2000); await f.stop(b);
    await release();
    assert.equal(a.playing, true);
});

test('a hanging tabs.get cannot block subsequent events indefinitely', async () => {
    const f = fixture(); f.start();
    const a = f.tab(1), b = f.tab(2), c = f.tab(3);
    await f.play(a);
    const get = f.context.chrome.tabs.get;
    f.context.chrome.tabs.get = id => id === 2 ? new Promise(() => {}) : get(id);
    await f.play(b); await f.play(c); await f.tick(2000);
    assert.equal(a.playing, false);
    await f.stop(c);
    assert.equal(a.playing, true);
});

test('old pause records cannot restart an element manually paused in a later cycle', async () => {
    const f = fixture(); f.start();
    const a = f.tab(1), b = f.tab(2), c = f.tab(3), d = f.tab(4);
    await f.play(a); await f.play(b); await f.play(c);
    await f.play(a);
    a.stop(); // Audio notification has not arrived yet.
    await f.play(d); await f.stop(d);
    assert.equal(a.playing, false);
});

test('successful calls leave no timeout timers behind', async () => {
    const f = fixture(); f.start();
    const a = f.tab(1), b = f.tab(2);
    await f.play(a); await f.play(b); await f.stop(b);
    assert.equal(f.timers.size, 0);
});
