/**
 * Companion to CSS/automate-bookmark-bar.css.
 * Entering a guest webview can leave the toolbar's :hover state stale.
 * A temporary UI surface detects that crossing and removes itself immediately.
 * It needs no page injection and also works on internal browser pages.
 */
(() => {
    const key = Symbol.for('mod.automateBookmarkBar');
    window[key]?.();
    const selector = '#app:not(.fullscreen-listener-enabled):has(#switch button[title="automate-bookmark-bar"]) .bookmark-bar-top:not(.toolbar-edit-mode):not(:has(.toolbar-editor)) .bookmark-bar';
    const controller = new AbortController();
    let sensor = null;
    const clear = () => {sensor?.remove(); sensor = null;};
    document.addEventListener('pointermove', event => {
        const bar = event.target.closest?.('.bookmark-bar');
        if (!bar?.matches(selector)) {clear(); return;}
        bar.removeAttribute('data-page-pointer');
        if (sensor?.isConnected) return;
        const content = document.getElementById('webview-container');
        if (!content) return;
        sensor = document.createElement('div');
        sensor.className = 'bookmark-bar-page-sensor';
        sensor.setAttribute('aria-hidden', 'true');
        sensor.style.cssText = 'position:absolute;inset:0;z-index:1;';
        sensor.addEventListener('pointerenter', () => {
            clear();
            if (bar.isConnected && bar.matches(selector)) bar.setAttribute('data-page-pointer', '');
        }, {once: true});
        content.append(sensor);
    }, {capture: true, passive: true, signal: controller.signal});
    document.addEventListener('dragstart', clear, {capture: true, signal: controller.signal});
    const destroy = () => {
        controller.abort();
        clear();
        document.querySelectorAll('.bookmark-bar[data-page-pointer]').forEach(bar => bar.removeAttribute('data-page-pointer'));
        removeEventListener('unload', destroy);
        if (window[key] === destroy) delete window[key];
    };
    window[key] = destroy;
    addEventListener('unload', destroy, {once: true});
})();
