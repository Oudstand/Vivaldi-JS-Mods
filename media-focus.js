/* Media focus: When a tab starts playing audible media, pause the previous tab.
 * Resume the previous tab when the new playback pauses, ends, or its tab closes.
 * Works per browser window (tabs and web panels); remembers one interrupted tab.
 * Uses the page's Media Session handlers, like a media key, or falls back to
 * controlling its audio/video elements directly.
 */
(() => {
    'use strict';
    window.mediaFocus?.destroy();

    const SILENCE_RECHECK_MS = 3000;
    const CALL_TIMEOUT_MS = 2000;
    const signals = new Map(); // Tab ID → latest audio event; older events are discarded

    let current = null;      // ID of the tab currently playing
    let interrupted = null;  // {tabId, token}: only this specific pause operation may be resumed
    let recheck = 0;
    let active = true;
    let chain = Promise.resolve();

    // Process events sequentially to prevent page queries from overtaking each other.
    function queue(task) {
        chain = chain
            .then(() => active && task())
            .catch(error => console.debug('Media focus:', error));
    }

    function onAudioStateChanged(event) {
        const tabId = Number(event.target.tab_id);
        if (event.target.localName !== 'webview' || !(tabId > 0)) return;
        const signal = {};
        signals.set(tabId, signal);
        queue(event.audible ? () => started(tabId, signal) : () => stopped(tabId, signal));
    }
    const isCurrentSignal = (tabId, signal) => active && signals.get(tabId) === signal;

    // Audible and not confirmed paused: an unknown state counts as playing.
    async function started(tabId, signal) {
        if (!isCurrentSignal(tabId, signal)) return;
        if (tabId === current) {
            clearTimeout(recheck);
            return;
        }
        if (await isMuted(tabId) || !isCurrentSignal(tabId, signal)) return;
        const state = await playState(tabId);
        if (!isCurrentSignal(tabId, signal) || state === 'paused') return;
        clearTimeout(recheck);
        interrupted = current ? {tabId: current, token: crypto.randomUUID()} : null;
        current = tabId;
        if (interrupted) await setPaused(interrupted, true);
    }

    // Vivaldi reports "no longer audible" just fractions of a second after the last sound.
    async function stopped(tabId, signal, waited = false) {
        if (tabId !== current || !isCurrentSignal(tabId, signal)) return;
        clearTimeout(recheck);
        const state = await playState(tabId);
        if (!isCurrentSignal(tabId, signal)) return;
        // If the player is still playing, this is a silent passage: check again later.
        // For an unknown state, wait once so a track change is not mistaken for a stop.
        // If the tab becomes audible again first, started() cancels the wait.
        if (state === 'playing' || (state === 'unknown' && !waited)) {
            recheck = setTimeout(() => queue(() => stopped(tabId, signal, state === 'unknown')), SILENCE_RECHECK_MS);
            return;
        }
        await resumeInterrupted();
    }

    async function resumeInterrupted() {
        const previous = interrupted;
        current = previous?.tabId ?? null;
        interrupted = null;
        if (previous) await setPaused(previous, false);
    }

    const onRemoved = tabId => {
        signals.delete(tabId);
        queue(async () => {
            if (tabId === interrupted?.tabId) interrupted = null;
            if (tabId === current) {
                clearTimeout(recheck);
                await resumeInterrupted();
            }
        });
    };

    // Also limits tabs.get; a stalled call must not block the queue indefinitely.
    async function withTimeout(call) {
        let timer;
        try {
            const timeout = new Promise(resolve => {
                timer = setTimeout(resolve, CALL_TIMEOUT_MS, null);
            });
            return await Promise.race([call(), timeout]);
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }
    // Runs in the page's main world; returns [{frameId, result}], or null on error or timeout.
    const inPage = (target, func, ...args) => withTimeout(() =>
        chrome.scripting.executeScript({target, func, args, world: 'MAIN', injectImmediately: true}));
    // 'playing', 'paused', or 'unknown'. One frame reporting 'playing' is enough.
    // A pause requires confirmation from the main frame with no frame reporting otherwise.
    // Failed queries are unknown; subframes without results (e.g. sandboxed iframes
    // with scripts disabled) are ignored.
    const playState = async tabId => {
        const frames = await inPage({tabId, allFrames: true}, pagePlayState) ?? [];
        const states = frames.map(frame => frame.result);
        if (states.includes('playing')) return 'playing';
        const top = frames.find(frame => frame.frameId === 0)?.result;
        return top === 'paused' && !states.includes('unknown') ? 'paused' : 'unknown';
    };
    const setPaused = ({tabId, token}, pause) =>
        inPage({tabId, allFrames: true}, pageSetPaused, pause, token, Date.now() + CALL_TIMEOUT_MS);
    const isMuted = async tabId => {
        const tab = await withTimeout(() => chrome.tabs.get(tabId));
        return !tab || tab.mutedInfo?.muted === true;
    };

    // Install the Media Session hook as early as possible in each newly loaded page.
    const onCommitted = ({tabId, frameId}) => {
        inPage({tabId, frameIds: [frameId]}, pageWatchMediaSession);
    };

    function destroy() {
        active = false;
        clearTimeout(recheck);
        signals.clear();
        document.removeEventListener('audiostatechanged', onAudioStateChanged, true);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        chrome.webNavigation.onCommitted.removeListener(onCommitted);
    }
    // The event does not bubble, but the document can still capture it.
    document.addEventListener('audiostatechanged', onAudioStateChanged, true);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.webNavigation.onCommitted.addListener(onCommitted);
    // For pages already open, the hook only sees handlers registered from now on.
    chrome.tabs.query({}).then(tabs => {
        if (active) tabs.forEach(tab => inPage({tabId: tab.id, allFrames: true}, pageWatchMediaSession));
    }).catch(error => console.debug('Media focus:', error));
    window.mediaFocus = {destroy};

    // The following functions run in each frame of the page.

    // Remember the play/pause handlers the page registers for media keys.
    function pageWatchMediaSession() {
        const state = window[Symbol.for('vivaldi.mediaFocus')] ??= {handlers: new Map(), media: new Set(), viaSession: false};
        if (state.watching || !window.MediaSession) return;
        state.watching = true;
        const setActionHandler = MediaSession.prototype.setActionHandler;
        MediaSession.prototype.setActionHandler = function (action, handler) {
            setActionHandler.call(this, action, handler);
            if (action === 'play' || action === 'pause') {
                if (handler) state.handlers.set(action, handler);
                else state.handlers.delete(action);
            }
        };
    }

    function pagePlayState() {
        const session = navigator.mediaSession?.playbackState;
        if (session === 'playing') return 'playing';
        for (const media of document.querySelectorAll('audio,video')) {
            if (!media.paused && !media.ended && !media.muted && media.volume > 0) return 'playing';
        }
        // Many players (including Spotify) register handlers without reporting a playback state.
        const handlers = window[Symbol.for('vivaldi.mediaFocus')]?.handlers;
        return session !== 'paused' && handlers?.get('pause') ? 'unknown' : 'paused';
    }

    // Pause only what is not confirmed paused; resume only what was paused here.
    function pageSetPaused(pause, token, deadline) {
        // Promise.race does not cancel executeScript. An action that only starts
        // executing after the timeout must not change playback.
        if (Date.now() >= deadline) return;
        const state = window[Symbol.for('vivaldi.mediaFocus')] ??= {handlers: new Map(), media: new Set(), viaSession: false};
        const handler = state.handlers.get(pause ? 'pause' : 'play');
        const session = navigator.mediaSession?.playbackState;
        if (pause) {
            state.token = token;
            state.media.clear();
            state.viaSession = false;
            // Pause is not a toggle; it has no effect on a player that is already paused.
            if (handler && session !== 'paused') {
                handler({action: 'pause'});
                state.viaSession = true;
                return;
            }
            // Only audible elements; muted decorative videos keep playing.
            for (const media of document.querySelectorAll('audio,video')) {
                if (!media.paused && !media.ended && !media.muted && media.volume > 0) {
                    state.media.add(media);
                    media.pause();
                }
            }
        } else {
            if (state.token !== token) return;
            state.token = null;
            if (state.viaSession && handler && session !== 'playing') handler({action: 'play'});
            for (const media of state.media) {
                if (media.isConnected) media.play().catch(() => {});
            }
            state.media.clear();
            state.viaSession = false;
        }
    }
})();
