/**
 * Forum link: https://forum.vivaldi.net/topic/92477/some-javascript-to-automatically-hide-tab-bar-and-address-bar-and-show-them-by-hovering
 * Hides the tab bar and address bar when not hovering
 */
(() => {
    const bookmarkBarPadding = '6px', // set to '0px' to remove the padding around the bookmark bar
        showDelay = 125, // set to 0 to remove the delay
        hideDelay = 250, // set to 0 to remove the delay
        alwaysShowAddressBar = false, // always shows the address bar - set to true to enable the feature
        showAddressBarOnFocus = true, // shows the address bar on a new tab or if in focus - set to false to disable the feature
        showAddressBarPadding = 15, // moves the address bar on a new tab or if in focus to - positive and negative values are allowed
        updateHoverDivSize = false, // decreases the size for the hover divs in fullscreen mode - set ti false to disable the feature
        hidePanels = true, // set to false to not hide the panels
        hideTabs = true, // set to false to not hide the tabs - currently only works with vertical tabs
        useTwoLevelTabStack = false; // additionally observe the second tab-stack level directly

    function initFullscreen() {
        const isReady = () => document.head && document.getElementById('app') && document.getElementById('browser') && document.getElementById('webview-container');
        if (isReady()) {
            new FullscreenMod();
        } else {
            const observer = new MutationObserver((mutations, obs) => {
                if (isReady()) {
                    obs.disconnect();
                    new FullscreenMod();
                }
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
            addEventListener('unload', () => observer.disconnect(), {once: true});
        }
    }

    queueMicrotask(initFullscreen);

    class FullscreenMod {
        #elements = {};
        #updateHoverDivsTimeout = null;

        positions = ['top', 'bottom', 'left', 'right'];

        fullscreenEnabled = true;
        settingsReady = false;
        stateChanged = false;
        disposed = false;
        listenerController = null;
        webviewController = null;
        boundWebview = null;

        hoverDivTop;
        hoverDivLeft;
        hoverDivRight;
        hoverDivBottom;

        showTopTimeout;
        showLeftTimeout;
        showRightTimeout;
        showBottomTimeout;
        hideTimeout;

        layoutObserver = null;
        editObserver = null;
        resizeObserver = null;
        observedElements = new Set();
        heightsRAF = null;

        styleEl = null;
        handlers = null;

        constructor() {
            this.handlers = {
                hide: this.hide.bind(this),
                clearHideTimeout: this.clearHideTimeout.bind(this),
                showTop: this.showTop.bind(this),
                showLeft: this.showLeft.bind(this),
                showRight: this.showRight.bind(this),
                showBottom: this.showBottom.bind(this),
                clearTimeouts: this.clearTimeouts.bind(this),
                scheduleHeights: this.scheduleHeights.bind(this),
                shortcut: (id, combination) => {
                    if (combination === 'F11' && id === vivaldiWindowId) this.toggleFullScreen();
                },
                destroy: this.destroy.bind(this)
            };

            chrome.storage.local.get('fullScreenModEnabled').then(value => {
                if (this.disposed || this.stateChanged) return;
                this.settingsReady = true;
                this.fullscreenEnabled = value.fullScreenModEnabled !== false;
                this.syncEnabledState();
            }).catch(error => {
                console.debug('Fullscreen mod: Failed to read settings:', error);
                if (!this.disposed && !this.stateChanged) {
                    this.settingsReady = true;
                    this.syncEnabledState();
                }
            });
            this.editObserver = new MutationObserver(() => this.syncEnabledState());
            this.editObserver.observe(this.browser, {attributes: true, attributeFilter: ['class']});
            vivaldi.tabsPrivate.onKeyboardShortcut.addListener(this.handlers.shortcut);
            addEventListener('unload', this.handlers.destroy, {once: true});
        }

        createStyle() {
            let style = `
                .fullscreen-listener-enabled {
                    ${this.generalCSS()}
                    ${this.topCSS()}
                    ${this.leftCSS()}
                    ${this.rightCSS()}
                    ${this.bottomCSS()}
                }

                #app:not(.fullscreen-listener-enabled) .hover-div {
                    visibility: hidden;
                }
            `;

            if (bookmarkBarPadding) {
                style += `
                    .fullscreen-listener-enabled .bookmark-bar {
                        height: calc(30px + ${bookmarkBarPadding} + ${bookmarkBarPadding} / 2) !important;
                        padding-top: ${bookmarkBarPadding};
                        padding-bottom: calc(${bookmarkBarPadding} / 2);
                    }
                `;
            }

            if (!this.styleEl) {
                this.styleEl = document.createElement('style');
                document.head.appendChild(this.styleEl);
            }
            if (this.styleEl.textContent !== style) this.styleEl.textContent = style;
        }

        syncHoverDivs() {
            const needed = {
                top: Boolean(this.topCSS()),
                left: Boolean(this.leftCSS()),
                right: Boolean(this.rightCSS()),
                bottom: Boolean(this.bottomCSS())
            };
            for (const position of this.positions) {
                const suffix = position[0].toUpperCase() + position.slice(1);
                const key = 'hoverDiv' + suffix;
                if (needed[position] && !this[key]) {
                    this[key] = ['top', 'bottom'].includes(position) ? this.createHorizontalHoverDiv(position) : this.createVerticalHoverDiv(position);
                    const options = {signal: this.listenerController.signal};
                    this[key].addEventListener('pointerenter', this.handlers['show' + suffix], options);
                    this[key].addEventListener('pointerleave', this.handlers.clearTimeouts, options);
                    if (this.webView?.matches(':hover')) this.app.classList.add('hidden-' + position);
                } else if (!needed[position]) {
                    clearTimeout(this['show' + suffix + 'Timeout']);
                    this[key]?.remove();
                    this[key] = undefined;
                    this.app.classList.remove('hidden-' + position);
                }
            }
        }

        destroyHoverDivs() {
            for (const el of [this.hoverDivTop, this.hoverDivLeft, this.hoverDivRight, this.hoverDivBottom]) {
                el?.remove();
            }
            this.hoverDivTop = this.hoverDivLeft = this.hoverDivRight = this.hoverDivBottom = undefined;
        }

        rebuildStyle() {
            if (!this.listenerController || this.disposed) return;
            this.createStyle();
            this.syncHoverDivs();
            this.bindWebview();
            this.observeLayoutElements();
            this.calculateHeights();
            if (updateHoverDivSize) this.updateHoverDivs();
        }

        toggleFullScreen() {
            if (this.disposed) return;
            this.settingsReady = true;
            this.stateChanged = true;
            this.fullscreenEnabled = !this.fullscreenEnabled;
            this.syncEnabledState();
            chrome.storage.local.set({fullScreenModEnabled: this.fullscreenEnabled})
                .catch(error => console.debug('Fullscreen mod: Failed to save settings:', error));
        }

        syncEnabledState() {
            if (!this.settingsReady || this.disposed) return;
            if (this.fullscreenEnabled && !this.browser?.classList.contains('toolbar-edit-mode')) this.addFullScreenListener();
            else this.removeFullScreenListener();
        }

        addFullScreenListener() {
            if (this.listenerController || this.disposed) return;
            this.listenerController = new AbortController();
            this.app.classList.add('fullscreen-listener-enabled');
            addEventListener('resize', this.handlers.scheduleHeights, {passive: true, signal: this.listenerController.signal});
            this.startLayoutObservers();
            this.rebuildStyle();
            this.hide();
        }

        bindWebview() {
            const webview = this.webView;
            if (webview === this.boundWebview) return;
            this.webviewController?.abort();
            this.boundWebview = webview;
            this.webviewController = new AbortController();
            const options = {signal: this.webviewController.signal};
            webview?.addEventListener('pointerenter', this.handlers.hide, options);
            webview?.addEventListener('pointerleave', this.handlers.clearHideTimeout, options);
        }

        removeFullScreenListener() {
            this.listenerController?.abort();
            this.listenerController = null;
            this.webviewController?.abort();
            this.webviewController = null;
            this.boundWebview = null;
            this.clearTimeouts();
            this.clearHideTimeout();
            clearTimeout(this.#updateHoverDivsTimeout);
            this.#updateHoverDivsTimeout = null;
            this.stopLayoutObservers();
            this.destroyHoverDivs();
            this.app?.classList.remove('fullscreen-listener-enabled', ...this.positions.map(position => 'hidden-' + position));
        }

        destroy() {
            if (this.disposed) return;
            this.disposed = true;
            this.editObserver?.disconnect();
            this.removeFullScreenListener();
            this.styleEl?.remove();
            vivaldi.tabsPrivate.onKeyboardShortcut.removeListener(this.handlers.shortcut);
            removeEventListener('unload', this.handlers.destroy);
        }

        clearTimeouts() {
            for (const position of this.positions) {
                const key = 'show' + position[0].toUpperCase() + position.slice(1) + 'Timeout';
                clearTimeout(this[key]);
                this[key] = null;
            }
        }

        clearHideTimeout() {
            clearTimeout(this.hideTimeout);
            this.hideTimeout = null;
        }

        hide() {
            if (!this.listenerController) return;
            this.clearHideTimeout();
            this.clearTimeouts();
            this.hideTimeout = setTimeout(() => {
                this.hideTimeout = null;
                if (!this.listenerController) return;
                if (this.hoverDivTop) this.app.classList.add('hidden-top');
                if (this.hoverDivLeft) this.app.classList.add('hidden-left');
                if (this.hoverDivRight) this.app.classList.add('hidden-right');
                if (this.hoverDivBottom) this.app.classList.add('hidden-bottom');
            }, hideDelay);
        }

        showSide(position) {
            if (!this.listenerController) return;
            const suffix = position[0].toUpperCase() + position.slice(1);
            if (!this['hoverDiv' + suffix]) return;
            this.clearHideTimeout();
            const key = 'show' + suffix + 'Timeout';
            clearTimeout(this[key]);
            this[key] = setTimeout(() => {
                this[key] = null;
                if (this.listenerController) this.app.classList.remove('hidden-' + position);
            }, showDelay);
        }

        showTop() {
            this.showSide('top');
        }

        showLeft() {
            this.showSide('left');
        }

        showRight() {
            this.showSide('right');
        }

        showBottom() {
            this.showSide('bottom');
        }

        isWindowMaximized() {
            return this.browser?.classList.contains('maximized');
        }

        setHorizontalHoverDivHeight(hoverDiv) {
            if (hoverDiv) hoverDiv.style.height = updateHoverDivSize && this.isWindowMaximized() ? '1px' : '1.5rem';
        }

        setVerticalHoverDivWidth(hoverDiv) {
            if (hoverDiv) hoverDiv.style.width = updateHoverDivSize && this.isWindowMaximized() ? '1px' : '1.5rem';
        }

        updateHoverDivs() {
            if (this.#updateHoverDivsTimeout) clearTimeout(this.#updateHoverDivsTimeout);
            this.#updateHoverDivsTimeout = setTimeout(() => {
                this.#updateHoverDivsTimeout = null;
                if (!this.listenerController) return;
                this.setHorizontalHoverDivHeight(this.hoverDivTop);
                if (this.hoverDivLeft) this.setVerticalHoverDivWidth(this.hoverDivLeft);
                if (this.hoverDivRight) this.setVerticalHoverDivWidth(this.hoverDivRight);
                if (this.hoverDivBottom) this.setHorizontalHoverDivHeight(this.hoverDivBottom);
            }, 150);
        }

        createHorizontalHoverDiv(position) {
            const hoverDiv = document.createElement('div');
            this.setHorizontalHoverDivHeight(hoverDiv);
            hoverDiv.style.width = '100vw';
            hoverDiv.style.position = 'fixed';
            hoverDiv.style.left = '0';
            hoverDiv.style.zIndex = '10';
            hoverDiv.style[position] = '0';
            hoverDiv.className = 'hover-div';
            hoverDiv.classList.add(position);
            document.querySelector('#app').appendChild(hoverDiv);
            return hoverDiv;
        }

        createVerticalHoverDiv(position) {
            const hoverDiv = document.createElement('div');
            hoverDiv.style.height = '100%';
            this.setVerticalHoverDivWidth(hoverDiv);
            hoverDiv.style.position = 'fixed';
            hoverDiv.style.top = '0';
            hoverDiv.style.zIndex = '10';
            hoverDiv.style[position] = '0';
            hoverDiv.className = 'hover-div';
            hoverDiv.classList.add(position);
            document.querySelector('#app').appendChild(hoverDiv);
            return hoverDiv;
        }

        startLayoutObservers() {
            this.resizeObserver = new ResizeObserver(this.handlers.scheduleHeights);
            const selector = '#header, .mainbar, .bookmark-bar, #footer, #tabs-tabbar-container, .tabbar-wrapper, #panels-container, #webview-container' +
                (useTwoLevelTabStack ? ', #tabs-subcontainer' : '');
            this.layoutObserver = new MutationObserver(mutations => {
                const relevant = mutations.some(mutation => {
                    if (mutation.type === 'attributes') {
                        return [this.browser, this.tabBarContainer, this.panelsContainer].includes(mutation.target);
                    }
                    if (mutation.target === this.footer) return true;
                    return [...mutation.addedNodes, ...mutation.removedNodes].some(node =>
                        node.nodeType === Node.ELEMENT_NODE && (node.matches(selector) || node.querySelector(selector)));
                });
                if (relevant) this.scheduleHeights();
            });
            this.layoutObserver.observe(this.browser, {childList: true, subtree: true, attributes: true, attributeFilter: ['class']});
        }

        observeLayoutElements() {
            const elements = new Set([
                this.header, this.mainBar, this.bookmarkBar, this.footer,
                this.tabBarContainer, this.tabBarWrapper, this.panelsContainer,
                useTwoLevelTabStack && this.tabBarContainer?.querySelector('#tabs-subcontainer')
            ].filter(Boolean));
            for (const element of this.observedElements) {
                if (!elements.has(element)) this.resizeObserver.unobserve(element);
            }
            for (const element of elements) {
                if (!this.observedElements.has(element)) this.resizeObserver.observe(element);
            }
            this.observedElements = elements;
        }

        stopLayoutObservers() {
            this.layoutObserver?.disconnect();
            this.resizeObserver?.disconnect();
            this.layoutObserver = this.resizeObserver = null;
            this.observedElements.clear();
            if (this.heightsRAF) {
                cancelAnimationFrame(this.heightsRAF);
                this.heightsRAF = null;
            }
        }

        scheduleHeights() {
            if (!this.listenerController || this.heightsRAF) return;
            this.heightsRAF = requestAnimationFrame(() => {
                this.heightsRAF = null;
                this.rebuildStyle();
            });
        }

        calculateHeights() {
            let topOffset = 0;
            let bottomOffset = 0;

            const headerHeight = this.getHeight(this.header);
            const mainBarHeight = this.getHeight(this.mainBar);
            const bookmarkBarHeight = this.getHeight(this.bookmarkBar);
            const footerHeight = this.getHeight(this.footer);

            // Top
            if (this.tabBarPosition === 'top' || !this.addressBarTop) topOffset += headerHeight;
            if (this.addressBarTop) topOffset += mainBarHeight;
            if (this.bookmarksTop && this.bookmarkBar) topOffset += bookmarkBarHeight;

            // Bottom
            if (this.footer?.childNodes.length) bottomOffset += footerHeight;
            if (!this.addressBarTop) bottomOffset += mainBarHeight;
            if (!this.bookmarksTop && this.bookmarkBar) bottomOffset += bookmarkBarHeight;

            this.app.style.setProperty('--fs-top-offset', topOffset + 'px');
            this.app.style.setProperty('--fs-bottom-offset', bottomOffset + 'px');
            this.app.style.setProperty('--fs-header-height', headerHeight + 'px');
            this.app.style.setProperty('--fs-main-bar-height', mainBarHeight + 'px');
            this.app.style.setProperty('--fs-bookmark-bar-height', bookmarkBarHeight + 'px');
            this.app.style.setProperty('--fs-footer-height', footerHeight + 'px');
            const tabWidth = this.tabBarWrapper?.offsetWidth || 0;
            const panelWidth = this.panelsContainer?.offsetWidth || 0;
            this.app.style.setProperty('--fs-panel-width', panelWidth + 'px');
            for (const side of ['left', 'right']) {
                const width = (hideTabs && this.tabBarPosition === side ? tabWidth : 0) +
                    (hidePanels && this['panels' + side[0].toUpperCase() + side.slice(1)] ? panelWidth : 0);
                this.app.style.setProperty('--fs-' + side + '-offset', width + 'px');
            }
        }

        generalCSS() {
            let css = `
                #header, .mainbar, .bookmark-bar, #panels-container {
                    transition: transform .5s, opacity .5s ease-in-out, visibility .5s ease-in-out !important;
                }

                #header, .mainbar {
                    z-index: 8;
                }

                .mainbar {
                    position: absolute;
                    width: 100%;
                }

                .bookmark-bar  {
                    position: absolute;
                    left: 0;
                    right: 0;
                    z-index: 5;
                }

                #main {
                    padding-top: 0 !important;
                    position: absolute;
                    top: 0;
                    bottom: 0;
                    left: 0;
                    right: 0;

                    .inner {
                        position: unset;
                    }
                }

                .extensionIconPopupMenu, .button-popup {
                    z-index: 8;
                }

                footer {
                    margin-top: auto !important;
                }

                .hover-div {
                    transition: visibility 0.5s ease-in-out;
                }
            `;

            if (hidePanels) {
                css += `
                    #panels-container {
                        position: absolute !important;
                    }
                `;
            }

            return css;
        }

        topCSS() {
            const topElements = [];

            if (this.header && (this.tabBarPosition === 'top' || !this.addressBarTop)) topElements.push('#header');
            if (this.addressBarTop && this.mainBar) topElements.push('.mainbar');
            if (this.bookmarksTop && this.bookmarkBar) topElements.push('.bookmark-bar');

            if (topElements.length === 0) return '';

            const topElementsSelector = topElements.join(', ');

            let css = `
                &.hidden-top {
                    ${topElementsSelector} {
                        transform: translateY(calc(var(--fs-top-offset, 0px) * -1));
                        opacity: 0;
                    }
                }

                &:not(.hidden-top) .hover-div.top {
                    visibility: hidden;
                }
            `;

            if (this.addressBarTop) {
                if (alwaysShowAddressBar || showAddressBarOnFocus) {
                    css += `
                        &.hidden-top {
                            ${!alwaysShowAddressBar ? '#browser:has(.internal-page .startpage .SpeedDialView), #browser:has(.internal-page .startpage .Dashboard), #browser:has(.UrlBar-AddressField:focus-within) {' : ''}
                                .mainbar:has(.UrlBar-AddressField), #header:has(.UrlBar-AddressField) {
                                    opacity: 1;

                                    .UrlBar-AddressField {
                                        position: absolute;
                                        top: calc(var(--fs-top-offset, 0px) + ${showAddressBarPadding}px);
                                        left: 25vw;
                                        right: 25vw;
                                        width: 50vw !important;
                                    }
                                }
                            ${!alwaysShowAddressBar ? '}' : ''}
                        }
                    `;
                }

                if (this.bookmarksTop) {
                    css += `
                        .bookmark-bar-top-off .mainbar {
                            padding-bottom: 5px;
                            background: var(--colorAccentBg);
                        }
                    `;
                }

                if (this.tabBarPosition === 'top') {
                    css += `
                        .mainbar {
                            margin-top: var(--fs-header-height, 0px);
                        }
                    `;
                }
            }

            if (this.bookmarksTop) {
                css += `
                    .bookmark-bar {
                        top: 0;
                        margin-top: calc(var(--fs-top-offset, 0px) - var(--fs-bookmark-bar-height, 0px));
                    }
                `;
            }

            return css;
        }

        leftCSS() {
            const leftElements = [];
            let css = '';

            if (hideTabs && this.tabBarPosition === 'left' && this.tabBarWrapper) {
                leftElements.push('.tabbar-wrapper');
            }

            if (hidePanels && this.panelsLeft) {
                leftElements.push('#panels-container');
            }

            if (leftElements.length === 0) {
                return '';
            }

            css += `
                &.hidden-left {
                    ${leftElements.join(', ')} {
                        transform: translateX(calc(var(--fs-left-offset, 0px) * -1));
                        opacity: 0;
                        visibility: hidden;
                    }
                }

                &:not(.hidden-left) .hover-div.left {
                    visibility: hidden;
                }
            `;

            if (hideTabs && this.tabBarPosition === 'left') {
                css += `
                    .tabbar-wrapper {
                        position: absolute;
                        top: 0;
                        left: ${this.panelsLeft ? 'var(--fs-panel-width, 0px)' : '0px'};
                        z-index: 1;
                        transition: transform .5s, opacity .5s ease-in-out !important;

                        &  > .tabbar-wrapper {
                            position: static;
                        }
                    }
                `;
            }

            if (this.panelsLeft) {
                css += `
                    &.hidden-left .panel-group {
                        pointer-events: none;
                    }
                `;
            }

            return css;
        }

        rightCSS() {
            const rightElements = [];
            if (hideTabs && this.tabBarPosition === 'right' && this.tabBarWrapper) {
                rightElements.push('.tabbar-wrapper');
            }

            if (hidePanels && this.panelsRight) {
                rightElements.push('#panels-container');
            }

            if (rightElements.length === 0) {
                return '';
            }

            let css = `
                &.hidden-right {
                    ${rightElements.join(', ')} {
                        transform: translateX(var(--fs-right-offset, 0px));
                        opacity: 0;
                        visibility: hidden;
                    }
                }

                &:not(.hidden-right) .hover-div.right {
                    visibility: hidden;
                }
            `;

            if (hideTabs && this.tabBarPosition === 'right') {
                css += `
                    .tabbar-wrapper {
                        position: absolute;
                        top: 0;
                        right: ${this.panelsRight ? 'var(--fs-panel-width, 0px)' : '0px'};
                        z-index: 1;
                        transition: transform .5s, opacity .5s ease-in-out !important;

                        &  > .tabbar-wrapper {
                            position: static;
                        }
                    }
                `;
            }

            if (this.panelsRight) {
                css += `
                    &.hidden-right .panel-group {
                        pointer-events: none;
                    }
                `;
            }

            return css;
        }

        bottomCSS() {
            const bottomElements = [];

            if (this.footer?.childNodes.length) bottomElements.push('#footer');
            if (!this.addressBarTop && this.mainBar) bottomElements.push('.mainbar');
            if (!this.bookmarksTop && this.bookmarkBar) bottomElements.push('.bookmark-bar');

            if (bottomElements.length === 0) return '';

            let css = `
                &.hidden-bottom {
                    ${bottomElements.join(', ')} {
                        transform: translateY(var(--fs-bottom-offset, 0px));
                        opacity: 0;
                    }
                }

                &:not(.hidden-bottom) .hover-div.bottom {
                    visibility: hidden;
                }
            `;

            if (this.tabBarPosition === 'bottom') {
                css += `
                    #footer {
                        transition: transform .5s, opacity .5s ease-in-out !important;
                    }
                `;
            }

            if (!this.addressBarTop) {
                css += `
                    .mainbar {
                        margin-bottom: var(--fs-footer-height, 0px);
                    }
                `;

                if (alwaysShowAddressBar || showAddressBarOnFocus) {
                    css += `
                        &.hidden-bottom {
                           ${!alwaysShowAddressBar ? '#browser:has(.internal-page .startpage), #browser:has(.UrlBar-AddressField:focus-within) {' : ''}
                                .mainbar {
                                    opacity: 1;

                                    .UrlBar-AddressField {
                                        position: absolute;
                                        bottom: calc(var(--fs-main-bar-height, 0px) + 10px + ${showAddressBarPadding}px);
                                        left: 25vw;
                                        right: 25vw;
                                        width: 50vw !important;
                                    }
                                }
                           ${!alwaysShowAddressBar ? '}' : ''}
                        }
                    `;
                }

                if (!this.bookmarksTop) {
                    css += `
                        .bookmark-bar-bottom-off .mainbar {
                            background: var(--colorAccentBg);
                        }
                    `;
                }
            }

            if (!this.bookmarksTop) {
                css += `
                    .bookmark-bar {
                        bottom: calc(var(--fs-footer-height, 0px) + ${!this.addressBarTop ? 'var(--fs-main-bar-height, 0px)' : '0px'});
                        margin-bottom: 0;
                    }
                `;
            }

            return css;
        }

        #getElement(key, selector) {
            if (!this.#elements[key] || !this.#elements[key].isConnected) {
                this.#elements[key] = document.querySelector(selector);
            }
            return this.#elements[key];
        }

        get app() {
            return this.#getElement('app', '#app');
        }

        get browser() {
            return this.#getElement('browser', '#browser');
        }

        get webView() {
            return this.#getElement('webView', '#webview-container');
        }

        get header() {
            return this.#getElement('header', '#header');
        }

        get mainBar() {
            return this.#getElement('mainBar', '.mainbar');
        }

        get bookmarkBar() {
            return this.#getElement('bookmarkBar', '.bookmark-bar');
        }

        get panelsContainer() {
            return this.#getElement('panelsContainer', '#panels-container');
        }

        get tabBarContainer() {
            return this.#getElement('tabBarContainer', '#tabs-tabbar-container');
        }

        get tabBarWrapper() {
            return this.#getElement('tabBarWrapper', '.tabbar-wrapper');
        }

        get panelsLeft() {
            return this.panelsContainer?.classList.contains('left');
        }

        get panelsRight() {
            return this.panelsContainer?.classList.contains('right');
        }

        get footer() {
            return this.#getElement('footer', '#footer');
        }

        get tabBarPosition() {
            return this.positions.find(cls => this.tabBarContainer?.classList.contains(cls));
        }

        get addressBarTop() {
            return this.browser?.classList.contains('address-top');
        }

        get bookmarksTop() {
            return this.browser?.classList.contains('bookmark-bar-top');
        }

        getHeight(el) {
            return el?.offsetHeight || 0;
        }
    }
})();
