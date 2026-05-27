/*
 * Domain Button & Title in Address Bar
 * Based on work by @aminought (https://forum.vivaldi.net/topic/96072/address-bar-like-in-yandex-browser)
 * Refactored & Fixed for Vivaldi Fullscreen
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

        .UrlBar-UrlObfuscationWarning {
            display: none;
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

        .DomainText:hover:hover {
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
        #elements = {};
        urlFieldMutationObserver = null;
        titleMutationObserver = null;
        uiObserver = null;

        constructor() {
            this.#addStyle();
            this.uiObserver = this.#createUiObserver();
            this.#setupFeatures();
        }

        #setupFeatures() {
            this.urlFieldMutationObserver?.disconnect();
            this.titleMutationObserver?.disconnect();

            this.#placeDomainButton();
            this.#placePageTitle();

            this.urlFieldMutationObserver = this.#createUrlFieldMutationObserver();
            this.titleMutationObserver = this.#createTitleMutationObserver();
        }

        // listeners

        #createUrlFieldMutationObserver() {
            const urlFieldMutationObserver = new MutationObserver(() => {
                this.#placeDomainButton();
                this.#placePageTitle();
            });
            if (this.#urlFieldInput) {
                urlFieldMutationObserver.observe(this.#urlFieldInput, {
                    attributes: true,
                    attributeFilter: ['value']
                });
            }
            return urlFieldMutationObserver;
        }

        #createTitleMutationObserver() {
            const titleMutationObserver = new MutationObserver(() => {
                this.#placePageTitle();
            });
            if (this.#title) {
                titleMutationObserver.observe(this.#title, {
                    childList: true,
                    subtree: true
                });
            }
            return titleMutationObserver;
        }

        #createUiObserver() {
            const uiObserver = new MutationObserver(mutations => {
                // Check if AddressBar exists but our Button is missing (e.g. after Fullscreen toggle)
                if (this.#urlBarAddressField && !this.#domainButton) {
                    this.#setupFeatures();
                }
            });

            if (this.#browser) {
                uiObserver.observe(this.#browser, {attributes: true, attributeFilter: ['class']});
            }
            return uiObserver;
        }

        #addDomainButtonListener() {
            this.#domainButton.addEventListener(
                'click',
                async event => {
                    event.stopPropagation();
                    const domainInfo = await this.#getDomainInfo();
                    if (!domainInfo.clickable) return;

                    const prefix = this.#calculateDomainPrefix(domainInfo.type);
                    this.#activeWebview.setAttribute('src', prefix + domainInfo.domain);
                },
                true
            );
        }

        // builders

        #createStyle() {
            const style = document.createElement('style');
            style.innerHTML = STYLE;
            return style;
        }

        #createDomainButton(domainInfo) {
            const domainButton = document.createElement('button');
            domainButton.className = 'DomainButton';

            const domainText = this.#createDomainText(domainInfo.domain);
            domainButton.appendChild(domainText);

            this.#urlBarAddressField.insertBefore(domainButton, this.#urlBarUrlFieldWrapper);
            this.#addDomainButtonListener();
        }

        #createDomainText(domain) {
            const domainText = document.createElement('div');
            domainText.className = 'UrlFragment--Lowlight DomainText';
            domainText.innerText = this.#getDisplayDomain(domain);
            return domainText;
        }

        #createPageTitle() {
            if (this.#pageTitle) return;

            if (!this.#urlFragmentWrapper) {
                setTimeout(this.#createPageTitle.bind(this), 50);
                return;
            }

            const pageTitle = document.createElement('div');
            pageTitle.className = 'UrlFragment--Highlight PageTitle';
            pageTitle.innerText = this.#getTitle();

            this.#urlFragmentWrapper.appendChild(pageTitle);
        }

        // actions

        #addStyle() {
            this.#head.appendChild(this.#createStyle());
        }

        async #placeDomainButton() {
            const domainInfo = await this.#getDomainInfo();
            if (!this.#urlBarAddressField) return;

            if (this.#domainText) {
                this.#domainText.innerText = this.#getDisplayDomain(domainInfo.domain);
            } else {
                this.#createDomainButton(domainInfo);
            }
        }

        #placePageTitle() {
            if (!this.#pageTitle) {
                this.#createPageTitle();
            } else {
                this.#pageTitle.innerText = this.#getTitle();
            }
        }

        // helpers

        #getDisplayDomain(domain) {
            return domain.startsWith('www.') ? domain.replace('www.', '') : domain;
        }

        #getTitle() {
            if (!this.#title) return '';

            let title = this.#title.innerText;
            if (title === 'Vivaldi' && this.#activeWebview) {
                title = this.#parseTitleFromUrl(this.#activeWebview.getAttribute('src'));
            }

            return title;
        }

        async #getDomainInfo() {
            if (!this.#urlFragmentLink && !this.#urlFragmentHighlight) return {domain: ''};
            return await this.#parseUrlDomain(this.#urlFragmentLink ? this.#urlFragmentLink.innerText : this.#urlFragmentHighlight.innerText);
        }

        #calculateDomainPrefix(type) {
            if (type === 'url') {
                return 'https://';
            } else if (type === 'vivaldi') {
                return 'vivaldi://';
            } else if (type === 'about') {
                return '';
            } else {
                return null;
            }
        }

        #parseVivaldiDomain(url) {
            const regexp = /vivaldi:\/\/([^\/]*)/;
            const match = url.match(regexp);
            return match ? match[1] : url;
        }

        async #parseUrlDomain(url) {
            if (url.startsWith('vivaldi://')) {
                const domain = this.#parseVivaldiDomain(url);
                return {type: 'vivaldi', domain: domain, clickable: true};
            } else if (url.startsWith('file://')) {
                return {type: 'file', domain: 'file', clickable: false};
            } else if (url.startsWith('about:')) {
                return {type: 'about', domain: url, clickable: true};
            } else if (url.startsWith('chrome-extension://')) {
                try {
                    let extension = await chrome.management.get(url.match(/chrome-extension:\/\/([^/]+)/)[1]);
                    return {type: 'extension', domain: extension.name, clickable: false};
                } catch (e) {
                    return {type: 'extension', domain: 'Extension', clickable: false};
                }
            } else {
                return {type: 'url', domain: url, clickable: true};
            }
        }

        #parseTitleFromUrl(title) {
            const regexp = /\/([^\/]*)$/;
            const match = title.match(regexp);
            return match ? match[1] : title;
        }

        // getters

        #getElement(key, selector) {
            if (!this.#elements[key] || !this.#elements[key].isConnected) {
                this.#elements[key] = document.querySelector(selector);
            }
            return this.#elements[key];
        }

        get #browser() {
            return this.#getElement('browser', '#browser');
        }

        get #head() {
            return this.#getElement('head', 'head');
        }

        get #title() {
            return this.#getElement('title', 'title');
        }

        get #urlFieldInput() {
            return this.#getElement('urlFieldInput', '#urlFieldInput');
        }

        get #activeWebview() {
            return document.querySelector('.webpageview.active.visible webview');
        }

        get #urlBarAddressField() {
            return this.#getElement('urlBarAddressField', '.UrlBar-AddressField');
        }

        get #urlBarUrlFieldWrapper() {
            return this.#getElement('urlBarUrlFieldWrapper', '.UrlBar-AddressField .UrlBar-UrlFieldWrapper');
        }

        get #urlFragmentWrapper() {
            return document.querySelector('.UrlBar-AddressField .UrlFragment-Wrapper');
        }

        get #urlFragmentLink() {
            return document.querySelector('.UrlBar-AddressField .UrlFragment-Link');
        }

        get #urlFragmentHighlight() {
            return document.querySelector('.UrlBar-AddressField span.UrlFragment--Highlight');
        }

        get #domainButton() {
            return document.querySelector('.DomainButton');
        }

        get #domainText() {
            return document.querySelector('.UrlFragment--Lowlight.DomainText');
        }

        get #pageTitle() {
            return document.querySelector('.PageTitle');
        }
    }

    function initMod() {
        if (document.querySelector('#urlFieldInput')) {
            window.domainTitleBar = new DomainTitleBar();
        } else {
            const observer = new MutationObserver((mutations, obs) => {
                if (document.querySelector('#urlFieldInput')) {
                    obs.disconnect();
                    window.domainTitleBar = new DomainTitleBar();
                }
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
        }
    }

    initMod();
})();
