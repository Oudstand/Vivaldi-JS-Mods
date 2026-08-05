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
        useTwoLevelTabStack = false; // set to true if you use two level tab stack to recalculate height

    function initFullscreen() {
        const browser = document.getElementById('browser');
        if (browser) {
            console.log('Browser');
            new FullscreenMod();
        } else {
            const observer = new MutationObserver((mutations, obs) => {
                if (document.getElementById('browser')) {
                    obs.disconnect();
                    console.log('Browser');
                    new FullscreenMod();
                }
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
        }
    }

    queueMicrotask(initFullscreen);

    class FullscreenMod {
        #elements = {};
        #updateHoverDivsTimeout = null;

        positions = ['top', 'bottom', 'left', 'right'];

        fullscreenEnabled;

        hoverDivTop;
        hoverDivLeft;
        hoverDivRight;
        hoverDivBottom;

        showTopTimeout;
        showLeftTimeout;
        showRightTimeout;
        showBottomTimeout;
        hideTimeout;

        subcontainerObserver;
        heightsRAF = null;

        styleEl = null;
        handlers = null;

        constructor() {
            this.createStyle();
            this.handlers = {
                hide: this.hide.bind(this),
                clearHideTimeout: this.clearHideTimeout.bind(this),
                showTop: this.showTop.bind(this),
                showLeft: this.showLeft.bind(this),
                showRight: this.showRight.bind(this),
                showBottom: this.showBottom.bind(this),
                clearTimeouts: this.clearTimeouts.bind(this),
                updateHoverDivs: this.updateHoverDivs.bind(this)
            };

            chrome.storage.local.get('fullScreenModEnabled').then(value => {
                this.fullscreenEnabled = value.fullScreenModEnabled || value.fullScreenModEnabled == undefined;

                if (this.fullscreenEnabled) {
                    this.addFullScreenListener();
                }
            });
            vivaldi.tabsPrivate.onKeyboardShortcut.addListener((id, combination) => combination === 'F11' && id === vivaldiWindowId && this.toggleFullScreen());
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

            if (this.styleEl?.parentNode) this.styleEl.parentNode.removeChild(this.styleEl);
            this.styleEl = document.createElement('style');
            this.styleEl.textContent = style;
            document.head.appendChild(this.styleEl);

            // this.styleEl.appendChild(document.createTextNode(style));
            this.destroyHoverDivs();
            this.hoverDivTop = this.createHorizontalHoverDiv('top');
            this.hoverDivLeft = (hidePanels && this.panelsLeft) || this.tabBarPosition === 'left' ? this.createVerticalHoverDiv('left') : undefined;
            this.hoverDivRight = (hidePanels && this.panelsRight) || this.tabBarPosition === 'right' ? this.createVerticalHoverDiv('right') : undefined;
            this.hoverDivBottom =
                !this.addressBarTop || this.tabBarPosition === 'bottom' || !this.bookmarksTop || document.querySelector('#footer').childNodes.length
                    ? this.createHorizontalHoverDiv('bottom')
                    : undefined;
        }

        destroyHoverDivs() {
            for (const el of [this.hoverDivTop, this.hoverDivLeft, this.hoverDivRight, this.hoverDivBottom]) {
                el?.remove();
            }
            this.hoverDivTop = this.hoverDivLeft = this.hoverDivRight = this.hoverDivBottom = undefined;
        }

        rebuildStyle() {
            this.createStyle(); // CSS + Hover-Divs aus aktueller DOM-Lage
            if (updateHoverDivSize) this.updateHoverDivs();
            this.scheduleHeights(); // CSS-Variablen (--fs-*) frisch berechnen
        }

        toggleFullScreen() {
            this.fullscreenEnabled = !this.fullscreenEnabled;
            if (this.fullscreenEnabled) this.rebuildStyle();
            this.fullscreenEnabled ? this.addFullScreenListener() : this.removeFullScreenListener();
            chrome.storage.local.set({fullScreenModEnabled: this.fullscreenEnabled});
        }

        addFullScreenListener() {
            this.app.classList.add('fullscreen-listener-enabled');
            this.webView.addEventListener('pointerenter', this.hide.bind(this));

            if (hideDelay) this.webView.addEventListener('pointerleave', this.handlers.clearHideTimeout);

            this.hoverDivTop?.addEventListener('pointerenter', this.handlers.showTop);
            this.hoverDivTop?.addEventListener('pointerleave', this.handlers.clearTimeouts);
            this.hoverDivLeft?.addEventListener('pointerenter', this.handlers.showLeft);
            this.hoverDivLeft?.addEventListener('pointerleave', this.handlers.clearTimeouts);
            this.hoverDivRight?.addEventListener('pointerenter', this.handlers.showRight);
            this.hoverDivRight?.addEventListener('pointerleave', this.handlers.clearTimeouts);
            this.hoverDivBottom?.addEventListener('pointerenter', this.handlers.showBottom);
            this.hoverDivBottom?.addEventListener('pointerleave', this.handlers.clearTimeouts);

            if (updateHoverDivSize) addEventListener('resize', this.handlers.updateHoverDivs);

            this.startSubcontainerObserver();
            this.scheduleHeights();
            this.hide();
        }

        removeFullScreenListener() {
            this.app.classList.remove('fullscreen-listener-enabled');
            this.webView.removeEventListener('pointerenter', this.hide);

            if (hideDelay) this.webView.removeEventListener('pointerleave', this.handlers.clearHideTimeout);

            this.hoverDivTop?.removeEventListener('pointerenter', this.handlers.showTop);
            this.hoverDivTop?.removeEventListener('pointerleave', this.handlers.clearTimeouts);
            this.hoverDivLeft?.removeEventListener('pointerenter', this.handlers.showLeft);
            this.hoverDivLeft?.removeEventListener('pointerleave', this.handlers.clearTimeouts);
            this.hoverDivRight?.removeEventListener('pointerenter', this.handlers.showRight);
            this.hoverDivRight?.removeEventListener('pointerleave', this.handlers.clearTimeouts);
            this.hoverDivBottom?.removeEventListener('pointerenter', this.handlers.showBottom);
            this.hoverDivBottom?.removeEventListener('pointerleave', this.handlers.clearTimeouts);

            if (updateHoverDivSize) removeEventListener('resize', this.handlers.updateHoverDivs);

            this.stopSubcontainerObserver();
            this.show();
        }

        clearTimeouts() {
            if (this.showTopTimeout) clearTimeout(this.showTopTimeout);
            if (this.showLeftTimeout) clearTimeout(this.showLeftTimeout);
            if (this.showRightTimeout) clearTimeout(this.showRightTimeout);
            if (this.showBottomTimeout) clearTimeout(this.showBottomTimeout);
        }

        clearHideTimeout() {
            if (this.hideTimeout) clearTimeout(this.hideTimeout);
        }

        hide() {
            this.hideTimeout = setTimeout(() => {
                this.app.classList.add('hidden-top');
                if (this.hoverDivLeft) this.app.classList.add('hidden-left');
                if (this.hoverDivRight) this.app.classList.add('hidden-right');
                if (this.hoverDivBottom) this.app.classList.add('hidden-bottom');
            }, hideDelay);
        }

        show() {
            this.showTop();
            this.showLeft();
            this.showRight();
            this.showBottom();
        }

        showTop() {
            this.showTopTimeout = setTimeout(() => this.app.classList.remove('hidden-top'), showDelay);
        }

        showLeft() {
            if (this.hoverDivLeft) {
                this.showLeftTimeout = setTimeout(() => this.app.classList.remove('hidden-left'), showDelay);
            }
        }

        showRight() {
            if (this.hoverDivRight) {
                this.showRightTimeout = setTimeout(() => this.app.classList.remove('hidden-right'), showDelay);
            }
        }

        showBottom() {
            if (this.hoverDivBottom) {
                this.showBottomTimeout = setTimeout(() => this.app.classList.remove('hidden-bottom'), showDelay);
            }
        }

        isWindowMaximized() {
            return this.browser.classList.contains('maximized');
        }

        setHorizontalHoverDivHeight(hoverDiv) {
            hoverDiv.style.height = updateHoverDivSize && this.isWindowMaximized() ? '1px' : '1.5rem';
        }

        setVerticalHoverDivWidth(hoverDiv) {
            hoverDiv.style.width = updateHoverDivSize && this.isWindowMaximized() ? '1px' : '1.5rem';
        }

        updateHoverDivs() {
            if (this.#updateHoverDivsTimeout) clearTimeout(this.#updateHoverDivsTimeout);
            this.#updateHoverDivsTimeout = setTimeout(() => {
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

        startSubcontainerObserver() {
            if (!useTwoLevelTabStack || !this.tabBarContainer) return;

            this.subcontainerObserver = new MutationObserver(mutations => {
                for (const mutation of mutations) {
                    let hit = false;
                    for (let i = 0; i < mutation.addedNodes.length; i++) {
                        const node = mutation.addedNodes[i];
                        if (node.nodeType === Node.ELEMENT_NODE && node.id === 'tabs-subcontainer') {
                            hit = true;
                            break;
                        }
                    }
                    if (!hit) {
                        for (let i = 0; i < mutation.removedNodes.length; i++) {
                            const node = mutation.removedNodes[i];
                            if (node.nodeType === Node.ELEMENT_NODE && node.id === 'tabs-subcontainer') {
                                hit = true;
                                break;
                            }
                        }
                    }

                    if (hit) {
                        this.scheduleHeights();
                        break;
                    }
                }
            });

            this.subcontainerObserver.observe(this.tabBarContainer, {childList: true});
            addEventListener('resize', this.scheduleHeights.bind(this), {passive: true});
        }

        stopSubcontainerObserver() {
            if (this.subcontainerObserver) {
                this.subcontainerObserver.disconnect();
                this.subcontainerObserver = null;
            }
            if (this.heightsRAF) {
                cancelAnimationFrame(this.heightsRAF);
                this.heightsRAF = null;
            }
        }

        scheduleHeights() {
            if (this.heightsRAF) return;
            this.heightsRAF = requestAnimationFrame(() => {
                this.heightsRAF = null;
                this.calculateHeights();
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
            if (this.footer.childNodes.length) bottomOffset += footerHeight;
            if (!this.addressBarTop) bottomOffset += mainBarHeight;
            if (!this.bookmarksTop && this.bookmarkBar) bottomOffset += bookmarkBarHeight;

            this.app.style.setProperty('--fs-top-offset', topOffset + 'px');
            this.app.style.setProperty('--fs-bottom-offset', bottomOffset + 'px');
            this.app.style.setProperty('--fs-header-height', headerHeight + 'px');
            this.app.style.setProperty('--fs-main-bar-height', mainBarHeight + 'px');
            this.app.style.setProperty('--fs-bookmark-bar-height', bookmarkBarHeight + 'px');
            this.app.style.setProperty('--fs-footer-height', footerHeight + 'px');
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

            if (this.tabBarPosition === 'top' || !this.addressBarTop) topElements.push('#header');
            if (this.addressBarTop) topElements.push('.mainbar');
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
            let css = '',
                width = 0,
                tabBarWrapper;

            if (hideTabs && this.tabBarPosition === 'left') {
                leftElements.push('.tabbar-wrapper');
                tabBarWrapper = document.querySelector('.tabbar-wrapper');
                width += tabBarWrapper.offsetWidth;
            }

            if (hidePanels && this.panelsLeft) {
                leftElements.push('#panels-container');
                width += this.panelsContainer.offsetWidth;
            }

            if (leftElements.length === 0) {
                return '';
            }

            css += `
                &.hidden-left {
                    ${leftElements.join(', ')} {
                        transform: translateX(-${width}px);
                        opacity: 0;
                        visibility: hidden;
                    }
                }

                &:not(.hidden-left) .hover-div.left {
                    visibility: hidden;
                }
            `;

            if (this.tabBarPosition === 'left') {
                css += `
                    .tabbar-wrapper {
                        position: absolute;
                        top: 0;
                        left: ${this.panelsLeft ? this.panelsContainer.offsetWidth : 0}px;
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
            let width = 0,
                tabBarWrapper;

            if (hideTabs && this.tabBarPosition === 'right') {
                rightElements.push('.tabbar-wrapper');
                tabBarWrapper = document.querySelector('.tabbar-wrapper');
                width += tabBarWrapper.offsetWidth;
            }

            if (hidePanels && this.panelsRight) {
                rightElements.push('#panels-container');
                width += this.panelsContainer.offsetWidth;
            }

            if (rightElements.length === 0) {
                return '';
            }

            let css = `
                &.hidden-right {
                    ${rightElements.join(', ')} {
                        transform: translateX(${width}px);
                        opacity: 0;
                        visibility: hidden;
                    }
                }

                &:not(.hidden-right) .hover-div.right {
                    visibility: hidden;
                }
            `;

            if (this.tabBarPosition === 'right') {
                css += `
                    .tabbar-wrapper {
                        position: absolute;
                        top: 0;
                        right: ${this.panelsRight ? this.panelsContainer.offsetWidth : 0}px;
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

            if (this.footer.childNodes.length) bottomElements.push('#footer');
            if (!this.addressBarTop) bottomElements.push('.mainbar');
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
                            padding-bottom: -5px;
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
            return this.positions.find(cls => this.tabBarContainer.classList.contains(cls));
        }

        get addressBarTop() {
            return this.browser.classList.contains('address-top');
        }

        get bookmarksTop() {
            return this.browser.classList.contains('bookmark-bar-top');
        }

        getHeight(el) {
            return el?.offsetHeight || 0;
        }
    }
})();
