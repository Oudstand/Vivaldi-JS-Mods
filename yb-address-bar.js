/*
 * Address Bar like in Yandex Browser
 * Forum link: https://forum.vivaldi.net/topic/96072/address-bar-like-in-yandex-browser
 * Written by @aminought
 */
(function yb_address_bar() {
    "use strict";

    const STYLE = `
        .UrlBar-AddressField:has(.YBDomain){
            .UrlFragment--Lowlight:not(.YBDomain), .UrlFragment-LinkWrapper,.UrlFragment--Highlight:not(.YBTitle) {
                display: none;
            }

            &:focus-within .YBDomainButton {
                display: none;
            }
        }

        .UrlFragments:has(.YBTitle) {
            display: flex;
            width: 100%;
        }

        .UrlBar-UrlObfuscationWarning {
            display: none;
        }

        .YBDomainButton {
            background-color: var(--colorAccentBg);
            color: var(--colorAccentFg);
            height: 20px !important;
            margin-left: 4px;
            border: none;
            display: flex;
            align-items: center;

            &:has(.YBDomain:empty) {
                display: none;
            }

            &:not(:hover) {
                overflow: hidden !important;
            }
        }

        .YBDomainButton:hover {
            background-color: var(--colorAccentBgAlpha);
        }

        .YBDomain {
            height: 100%;
            max-width: 10rem;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .YBDomain:hover:hover {
          max-width: unset;
        }

        .YBTitle {
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

    class YBAddressBar {
        urlFieldMutationObserver = null;
        titleMutationObserver = null;

        constructor() {
            this.#addStyle();
            this.headerObserver = this.#createHeaderObserver();
            this.#setupFeatures();
        }

        #setupFeatures() {
            this.urlFieldMutationObserver?.disconnect();
            this.titleMutationObserver?.disconnect();

            this.#placeYBDomainButton();
            this.#placeYBTitle();

            this.urlFieldMutationObserver = this.#createUrlFieldMutationObserver();
            this.titleMutationObserver = this.#createTitleMutationObserver();
        }

        // listeners

        #createUrlFieldMutationObserver() {
            const urlFieldMutationObserver = new MutationObserver(() => {
                this.#placeYBDomainButton();
                this.#placeYBTitle();
            });
            urlFieldMutationObserver.observe(this.#urlFieldInput, {
                attributes: true,
                attributeFilter: ['value']
            });
            return urlFieldMutationObserver;
        }

        #createTitleMutationObserver() {
            const titleMutationObserver = new MutationObserver(() => {
                this.#placeYBTitle();
            });
            titleMutationObserver.observe(this.#title, {
                childList: true,
                subtree: true
            });
            return titleMutationObserver;
        }

        #createHeaderObserver() {
            const headerObserver = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (node.id === 'titlebar') {
                            this.#setupFeatures();
                            return;
                        }
                    }
                }
            });

            headerObserver.observe(this.#header, {childList: true});
            return headerObserver;
        }

        #addDomainButtonListener() {
            this.#ybDomainButton.addEventListener('click', async (event) => {
                event.stopPropagation();
                const domainInfo = await this.#getDomainInfo();
                if (!domainInfo.clickable) return;

                const prefix = this.#calculateDomainPrefix(domainInfo.type);
                this.#activeWebview.setAttribute('src', prefix + domainInfo.domain);
            }, true);
        }

        // builders

        #createStyle() {
            const style = document.createElement('style');
            style.innerHTML = STYLE;
            return style;
        }

        #createYBDomainButton(domainInfo) {
            const ybDomainButton = document.createElement('button');
            ybDomainButton.className = 'YBDomainButton';

            const ybDomain = this.#createYBDomain(domainInfo.domain);
            ybDomainButton.appendChild(ybDomain);

            this.#urlBarAddressField.insertBefore(ybDomainButton, this.#urlBarUrlFieldWrapper);
            this.#addDomainButtonListener();
        }

        #createYBDomain(domain) {
            const ybDomain = document.createElement('div');
            ybDomain.className = 'UrlFragment--Lowlight YBDomain';
            ybDomain.innerText = this.#getDisplayDomain(domain);
            return ybDomain;
        }

        #createYbTitle() {
            if (this.#ybTitle) return;

            if (!this.#urlFragmentWrapper) {
                setTimeout(this.#createYbTitle.bind(this), 50);
                return;
            }

            const ybTitle = document.createElement('div');
            ybTitle.className = 'UrlFragment--Highlight YBTitle';
            ybTitle.innerText = this.#getTitle();

            this.#urlFragmentWrapper.appendChild(ybTitle);
        }

        // actions

        #addStyle() {
            this.#head.appendChild(this.#createStyle());
        }

        async #placeYBDomainButton() {
            const domainInfo = await this.#getDomainInfo();
            if (!this.#urlBarAddressField) return;

            if (this.#ybDomain) {
                this.#ybDomain.innerText = this.#getDisplayDomain(domainInfo.domain);
            } else {
                this.#createYBDomainButton(domainInfo);
            }
        }

        #placeYBTitle() {
            if (!this.#ybTitle) {
                this.#createYbTitle();
            } else {
                this.#ybTitle.innerText = this.#getTitle();
            }
        }

        // helpers

        #getDisplayDomain(domain) {
            return domain.startsWith('www.') ? domain.replace('www.', '') : domain;
        }

        #getTitle() {
            if (!this.#title) return '';

            let title = this.#title.innerText;
            if (title === 'Vivaldi') {
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
            return url.match(regexp)[1];
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
                let extension = await chrome.management.get(url.match(/chrome-extension:\/\/([^/]+)/)[1]);
                return {type: 'extension', domain: extension.name, clickable: false};
            } else {
                return {type: 'url', domain: url, clickable: true};
            }
        }

        #parseTitleFromUrl(title) {
            const regexp = /\/([^\/]*)$/;
            return title.match(regexp)[1];
        }

        // getters

        get #head() {
            return document.querySelector('head');
        }

        get #header() {
            return document.querySelector('#header');
        }

        get #title() {
            return document.querySelector('title');
        }

        get #urlFieldInput() {
            return document.querySelector('#urlFieldInput');
        }

        get #activeWebview() {
            return document.querySelector('.webpageview.active.visible webview');
        }

        get #urlBarAddressField() {
            return document.querySelector('.UrlBar-AddressField');
        }

        get #urlBarUrlFieldWrapper() {
            return document.querySelector('.UrlBar-AddressField .UrlBar-UrlFieldWrapper');
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

        get #ybDomainButton() {
            return document.querySelector('.YBDomainButton');
        }

        get #ybDomain() {
            return document.querySelector('.UrlFragment--Lowlight.YBDomain');
        }

        get #ybTitle() {
            return document.querySelector('.YBTitle');
        }
    }

    function initMod() {
        if (document.querySelector('#urlFieldInput')) {
            window.ybAddressBar = new YBAddressBar();
        } else {
            setTimeout(initMod, 500);
        }
    }

    setTimeout(initMod, 500);
})();