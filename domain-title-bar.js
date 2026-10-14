/*
 * Domain Button & Title in Address Bar
 * Based on work by @aminought (https://forum.vivaldi.net/topic/96072/address-bar-like-in-yandex-browser)
 * Uses native tab metadata and restores its UI when the address bar is rebuilt
 */
(function domain_title_bar() {
    'use strict';

    const STYLE = `
        .UrlBar-AddressField:has(.DomainText){
            .UrlFragment--Lowlight:not(.DomainText), .UrlFragment-LinkWrapper,.UrlFragment--Highlight:not(.PageTitle) {
                display: none;
            }

            &:focus-within .DomainButton {
                display: none;
            }
        }

        .UrlFragments:has(.PageTitle) {
            display: flex;
            width: 100%;
        }

        .DomainButton {
            background-color: var(--colorAccentBg);
            color: var(--colorAccentFg);
            height: 20px !important;
            margin-left: 4px;
            border: none;
            display: flex;
            align-items: center;

            &:has(.DomainText:empty) {
                display: none;
            }

            &:not(:hover) {
                overflow: hidden !important;
            }
        }

        .DomainButton:hover {
            background-color: var(--colorAccentBgAlpha);
        }

        .DomainText {
            height: 100%;
            max-width: 10rem;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .DomainText:hover {
          max-width: unset;
        }

        .PageTitle {
            width: 100%;
            margin-left: 10px;
            margin-right: 10px;
            text-align: center;
            overflow: hidden;
            text-overflow: ellipsis;
            line-height: 26px;
            font-size: 14px;
        }

        .UrlField--IsEmpty:has(#urlFieldInput:not(:focus)) {
            #urlFieldInput {
                opacity: 0;
            }

            .UrlFragments {
                opacity: 1;
            }
        }
    `;

    class DomainTitleBar {
        #tab = null;
        #url = '';
        #info = {domain: '', target: null};
        #version = 0;
        #frame = null;
        #disposed = false;
        #controller = new AbortController();
        #listeners = [];
        #buttons = new WeakSet();
        #extensions = new Map();
        #observer;
        #style;
        #tooltipArea = null;
        #tooltipCleanup = null;

        constructor() {
            this.#style = document.createElement('style');
            this.#style.textContent = STYLE;
            document.head.appendChild(this.#style);

            this.#listen(chrome.tabs.onActivated, ({tabId, windowId}) => {
                if (windowId !== vivaldiWindowId) return;
                this.#setTab({id: tabId});
                this.#refresh(tabId);
            });
            this.#listen(chrome.tabs.onUpdated, (tabId, changes, tab) => {
                if (tab.windowId !== vivaldiWindowId || (this.#tab ? tabId !== this.#tab.id : !tab.active)) return;
                if (['url', 'pendingUrl', 'title', 'status'].some(key => key in changes)) this.#setTab(tab);
            });
            this.#listen(chrome.tabs.onRemoved, tabId => {
                if (tabId === this.#tab?.id) {
                    this.#setTab(null);
                    this.#refresh();
                }
            });
            this.#listen(chrome.tabs.onReplaced, (addedId, removedId) => {
                if (removedId === this.#tab?.id) {
                    this.#setTab({id: addedId});
                    this.#refresh(addedId);
                }
            });

            const selector = '.UrlBar-AddressField, .UrlBar-UrlFieldWrapper, .UrlFragment-Wrapper, .DomainButton, .DomainText, .PageTitle';
            this.#observer = new MutationObserver(mutations => {
                if (mutations.some(mutation => [...mutation.addedNodes, ...mutation.removedNodes].some(node =>
                    node.nodeType === Node.ELEMENT_NODE && (node.matches(selector) || node.querySelector(selector))))) {
                    this.#scheduleRender();
                }
            });
            this.#observer.observe(document.getElementById('browser'), {childList: true, subtree: true});
            addEventListener('unload', () => this.destroy(), {once: true, signal: this.#controller.signal});
            this.#refresh();
        }

        #listen(event, handler) {
            event.addListener(handler);
            this.#listeners.push([event, handler]);
        }

        async #refresh(tabId) {
            const version = ++this.#version;
            try {
                const tab = tabId === undefined ? (await chrome.tabs.query({active: true, windowId: vivaldiWindowId}))[0] : await chrome.tabs.get(tabId);
                if (!this.#disposed && version === this.#version) this.#setTab(tab);
            } catch (error) {
                if (!this.#disposed && version === this.#version) {
                    this.#setTab(null);
                    console.debug('Domain title bar: Failed to read active tab:', error);
                }
            }
        }

        #setTab(tab) {
            const version = ++this.#version;
            this.#tab = tab || null;
            this.#url = tab?.pendingUrl || tab?.url || '';
            this.#info = DomainTitleBar.getUrlInfo(this.#url);
            this.#scheduleRender();
            if (!this.#info.extensionId) return;

            const id = this.#info.extensionId;
            if (!this.#extensions.has(id)) {
                this.#extensions.set(id, chrome.management.get(id).then(extension => extension.name).catch(() => 'Extension'));
            }
            this.#extensions.get(id).then(name => {
                if (this.#disposed || version !== this.#version) return;
                this.#info.domain = name;
                this.#scheduleRender();
            });
        }

        static getUrlInfo(raw) {
            try {
                const url = new URL(raw.replace(/^vivaldi:([^/])/, 'vivaldi://$1'));
                switch (url.protocol) {
                    case 'http:':
                    case 'https:':
                        return {domain: url.host, target: url.origin + '/'};
                    case 'vivaldi:':
                    case 'chrome:':
                        return {domain: 'vivaldi:' + url.host, target: url.href};
                    case 'about:':
                        return {domain: url.href, target: url.href};
                    case 'file:':
                        return {domain: 'file', target: null};
                    case 'chrome-extension:':
                        return {domain: 'Extension', target: null, extensionId: url.hostname};
                    default:
                        return {domain: url.protocol.slice(0, -1), target: null};
                }
            } catch {
                return {domain: '', target: null};
            }
        }

        #scheduleRender() {
            if (this.#disposed || this.#frame !== null) return;
            this.#frame = requestAnimationFrame(() => {
                this.#frame = null;
                this.#render();
            });
        }

        #render() {
            if (this.#disposed) return;
            const field = document.querySelector('#browser .UrlBar-AddressField');
            if (!field) {
                this.#setTitleTooltip(null, '');
                return;
            }

            let button = field.querySelector('.DomainButton');
            if (!button) {
                button = document.createElement('button');
                button.type = 'button';
                button.className = 'DomainButton';
                field.insertBefore(button, field.querySelector('.UrlBar-UrlFieldWrapper'));
            }
            if (!this.#buttons.has(button)) {
                this.#buttons.add(button);
                button.addEventListener('click', event => {
                    event.stopPropagation();
                    const tabId = Number(button.dataset.tabId), target = button.dataset.target;
                    if (!target || tabId !== this.#tab?.id || target !== this.#info.target) return;
                    chrome.tabs.update(tabId, {url: target}).catch(error => console.debug('Domain title bar: Navigation failed:', error));
                }, {signal: this.#controller.signal});
            }
            let text = button.querySelector('.DomainText');
            if (!text) {
                text = document.createElement('div');
                text.className = 'UrlFragment--Lowlight DomainText';
                button.appendChild(text);
            }
            const domain = this.#info.domain.replace(/^www\./, '');
            if (text.textContent !== domain) text.textContent = domain;
            button.disabled = !this.#info.target;
            button.title = this.#info.target || this.#info.domain;
            button.dataset.tabId = this.#tab?.id ?? '';
            button.dataset.target = this.#info.target || '';

            const wrapper = field.querySelector('.UrlFragment-Wrapper');
            if (!wrapper) {
                this.#setTitleTooltip(null, '');
                return;
            }
            let title = wrapper.querySelector('.PageTitle');
            if (!title) {
                title = document.createElement('div');
                title.className = 'UrlFragment--Highlight PageTitle';
                wrapper.appendChild(title);
            }
            const pending = this.#tab?.pendingUrl && this.#tab.pendingUrl !== this.#tab.url;
            const value = !pending && this.#tab?.title && this.#tab.title !== 'Vivaldi' ? this.#tab.title : this.#info.domain || this.#url;
            if (title.textContent !== value) title.textContent = value;
            title.title = value;
            this.#setTitleTooltip(field.querySelector('.UrlBar-UrlFieldWrapper'), value);
        }

        #setTitleTooltip(area, value) {
            if (area !== this.#tooltipArea) {
                this.#tooltipCleanup?.();
                this.#tooltipArea = area;
                this.#tooltipCleanup = null;
                if (area) {
                    const original = area.getAttribute('title');
                    const restore = () => original === null ? area.removeAttribute('title') : area.setAttribute('title', original);
                    const onBlur = () => this.#scheduleRender();
                    area.addEventListener('focusin', restore);
                    area.addEventListener('focusout', onBlur);
                    this.#tooltipCleanup = () => {
                        area.removeEventListener('focusin', restore);
                        area.removeEventListener('focusout', onBlur);
                        restore();
                    };
                }
            }
            // The transparent native input receives the pointer and inherits this tooltip.
            if (area && !area.matches(':focus-within')) area.title = value;
        }

        destroy() {
            if (this.#disposed) return;
            this.#disposed = true;
            this.#version++;
            this.#controller.abort();
            this.#observer.disconnect();
            this.#tooltipCleanup?.();
            cancelAnimationFrame(this.#frame);
            for (const [event, handler] of this.#listeners) event.removeListener(handler);
            this.#listeners.length = 0;
            this.#extensions.clear();
            document.querySelectorAll('#browser .DomainButton, #browser .PageTitle').forEach(element => element.remove());
            this.#style.remove();
        }
    }

    function initMod() {
        const ready = () => document.head && document.getElementById('browser');
        const start = () => {
            window.domainTitleBar?.destroy?.();
            window.domainTitleBar = new DomainTitleBar();
        };
        if (ready()) start();
        else {
            const observer = new MutationObserver(() => {
                if (ready()) {
                    observer.disconnect();
                    start();
                }
            });
            observer.observe(document.documentElement, {childList: true, subtree: true});
            addEventListener('unload', () => observer.disconnect(), {once: true});
        }
    }

    initMod();
})();
