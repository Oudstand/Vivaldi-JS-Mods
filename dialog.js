/**
 * Opens links in a dialog, either by key combinations, holding the middle mouse button or context menu
 * Forum link: https://forum.vivaldi.net/topic/92501/open-in-dialog-mod?_=1717490394230
 */
(() => {
    const UI_CONFIG = {
            showUrlInput: true // true = shows the URL input in the options container, false = title + buttons only
        },
        ICON_CONFIG = {
            linkIcon: '', // available values: 'arrow-up-right', 'info-circle', 'square-outline'; set to '' to disable
            linkIconInteractionOnHover: true, // if false, you have to click the icon to show the dialog - if true, the dialog shows on mouseenter
            showIconDelay: 250, // set to 0 to disable - delays showing the icon on hovering a link
            showDialogOnHoverDelay: 250 // set to 0 to disable - delays showing the dialog on hovering the linkIcon
        },
        CONTEXT_MENU_CONFIG = {
            menuPrefix: '[Dialog]',
            linkMenuTitle: 'Link öffnen',
            searchMenuTitle: 'Suche nach "%s"',
            selectSearchMenuTitle: 'Suche mit'
        },
        TOOLTIP_CONFIG = {
            back: 'Zurück',
            forward: 'Vorwärts',
            reload: 'Neu laden',
            readerView: 'Reader View umschalten',
            newTab: 'In neuem Tab öffnen',
            backgroundTab: 'Im Hintergrund öffnen'
        },
        TIMING_CONFIG = {
            middleClickDelay: 500,
            titleFetchDelay: 300
        };

    // Wait for the browser to come to a ready state
    function initDialog() {
        if (document.getElementById('browser')) {
            new DialogMod();
        } else {
            const observer = new MutationObserver((mutations, obs) => {
                if (document.getElementById('browser')) {
                    obs.disconnect();
                    new DialogMod();
                }
            });
            observer.observe(document.documentElement, {childList: true, subtree: true});
        }
    }

    queueMicrotask(initDialog);

    class DialogLifetime {
        #controller = new AbortController();
        #cleanupFns = [];
        #disposed = false;

        get signal() {
            return this.#controller.signal;
        }

        add(cleanupFn) {
            if (this.#disposed) {
                cleanupFn();
                return;
            }

            this.#cleanupFns.push(cleanupFn);
        }

        dispose() {
            if (this.#disposed) return;
            this.#disposed = true;

            this.#controller.abort();

            for (const cleanupFn of this.#cleanupFns.splice(0)) {
                cleanupFn();
            }
        }
    }

    class DialogMod {
        // Animation constants
        ANIMATION_DURATIONS = {
            CLOSE_TIMEOUT: 800, // Fallback timeout for close animation
            OPTIONS_FADE: 300, // Fade timing for swapping title and options
            OPTIONS_HIDE: 1500 // Options container hide delay
        };

        // Cached canvas context for text measurement (performance optimization)
        #canvasContext = document.createElement('canvas').getContext('2d');

        webviews = new Map();
        iconUtils = new IconUtils();
        searchEngineUtils = new SearchEngineUtils(
            url => this.dialogTab(url),
            (engineId, searchText) => this.dialogTabSearch(engineId, searchText),
            CONTEXT_MENU_CONFIG
        );
        KEYBOARD_SHORTCUTS = {
            'Ctrl+Alt+Period': this.searchForSelectedText.bind(this),
            'Ctrl+Shift+F': this.searchForSelectedText.bind(this),
            Esc: () => {
                if (!this.webviews.size) return;

                const webviewValues = Array.from(this.webviews.values());
                let webviewData = webviewValues.at(-1);
                if (!webviewData.fromPanel) {
                    const tabId = Number(this.getActiveWebview()?.tab_id);
                    webviewData = webviewValues.findLast(_data => _data.tabId === tabId);
                }
                if (!webviewData) return;

                const {webview, lifetime} = webviewData;
                webview.executeScript({code: DialogFullscreen.EXIT_SCRIPT}, results => {
                    const failed = Boolean(chrome.runtime.lastError);
                    if (!lifetime.signal.aborted && (failed || !results?.[0])) this.removeDialog(webview.id);
                });
            }
        };
        constructor() {
            // Setup keyboard shortcuts
            vivaldi.tabsPrivate.onKeyboardShortcut.addListener(this.keyCombo.bind(this));

            new WebviewLinkInteractionUtils(
                webview => this.getWebviewFromPanel(webview),
                (url, fromPanel, origin) => this.dialogTab(url, fromPanel, origin),
                TIMING_CONFIG
            );

            if (ICON_CONFIG.linkIcon) {
                new WebsiteInjectionUtils(
                    webview => this.getWebviewFromPanel(webview),
                    (url, fromPanel, origin) => this.dialogTab(url, fromPanel, origin),
                    ICON_CONFIG,
                    TIMING_CONFIG
                );
            }
        }

        getWebviewFromPanel(webview) {
            return this.webviews.get(webview.id)?.fromPanel ?? webview.name === 'vivaldi-webpanel';
        }

        getActiveWebview() {
            return document.querySelector('.active.visible.webpageview webview');
        }

        /**
         * Open Default Search Engine in Dialog and search for the selected text
         * @returns {Promise<void>}
         */
        async searchForSelectedText() {
            const tabs = await chrome.tabs.query({active: true});
            vivaldi.utilities.getSelectedText(tabs[0].id, text => this.dialogTabSearch(this.searchEngineUtils.defaultSearchId, text));
        }

        /**
         * Prepares url for search, calls dialogTab function
         * @param {String} engineId engine id of the engine to be used
         * @param {int} selectionText the text to search
         */
        async dialogTabSearch(engineId, selectionText) {
            let searchRequest = await vivaldi.searchEngines.getSearchRequest(engineId, selectionText);
            this.dialogTab(searchRequest.url);
        }

        /**
         * Handle a potential keyboard shortcut (copy from KeyboardMachine)
         * @param {number} id I don't know what this does, but it's an extra argument
         * @param {String} combination written in the form (CTRL+SHIFT+ALT+KEY)
         */
        keyCombo(id, combination) {
            const customShortcut = this.KEYBOARD_SHORTCUTS[combination];
            if (customShortcut) {
                customShortcut();
            }
        }

        cleanupDialog(webviewId) {
            const data = this.webviews.get(webviewId);
            if (!data) return;

            data.lifetime?.dispose();
        }

        removeAssociatedTab(webviewId) {
            const tabId = this.webviews.get(webviewId)?.relatedTabId;
            if (!tabId) return;

            chrome.tabs.remove(tabId);
        }

        /**
         * Removes the dialog for a given webview
         * @param webviewId The id of the webview
         */
        removeDialog(webviewId) {
            const data = this.webviews.get(webviewId);
            if (!data) return;

            const container = data.divContainer;
            const dialogTab = container.querySelector('.dialog-tab');
            const lifetime = data.lifetime;

            if (container.dataset.closing === '1') return;
            container.dataset.closing = '1';

            const pointerX = Number(container.dataset.pointerX ?? window.innerWidth / 2);
            const pointerY = Number(container.dataset.pointerY ?? window.innerHeight / 2);

            // Recompute anchored translate for current layout
            this.setAnchoredTransformVars(dialogTab, pointerX, pointerY);

            requestAnimationFrame(() => {
                container.classList.remove('is-open'); // overlay fades out via transition
                container.classList.add('is-leave'); // optional: block clicks

                dialogTab.classList.add('animating-close');

                let removalFinished = false;
                const finishRemoval = () => {
                    if (removalFinished) return;
                    removalFinished = true;

                    container.classList.remove('is-leave');
                    this.cleanupDialog(webviewId);
                    data.divContainer.remove();

                    this.webviews.delete(webviewId);
                };

                const onCloseEnd = e => {
                    if (e.animationName === 'dialog-tab-close-anchored') {
                        finishRemoval();
                    }
                };
                dialogTab.addEventListener('animationend', onCloseEnd, {signal: lifetime.signal});

                // Fallback in case animationend doesn't fire
                const closeFallback = setTimeout(finishRemoval, this.ANIMATION_DURATIONS.CLOSE_TIMEOUT);
                lifetime.add(() => clearTimeout(closeFallback));
            });
        }

        /**
         * Checks if the current window is the correct window to show the dialog and then opens the dialog
         * @param {string} linkUrl the url to load
         * @param {boolean} fromPanel indicates whether the dialog is opened from a panel
         * @param {{x:number, y:number}} origin the viewport coordinates to anchor the animation
         */
        dialogTab(linkUrl, fromPanel = undefined, origin = undefined) {
            chrome.windows.getLastFocused(window => {
                if (window.id === vivaldiWindowId && window.state !== chrome.windows.WindowState.MINIMIZED) {
                    this.showDialog(linkUrl, fromPanel, origin); // pass origin through
                }
            });
        }

        /**
         * Opens a link in a dialog like display in the current visible tab
         * @param {string} linkUrl the url to load
         * @param {boolean} fromPanel indicates whether the dialog is opened from a panel
         * @param {{x:number, y:number}} origin the viewport coordinates to anchor the animation
         */
        showDialog(linkUrl, fromPanel, origin) {
            const dialogContainer = document.createElement('div'),
                dialogTab = document.createElement('div'),
                webview = document.createElement('webview'),
                webviewId = `dialog-${this.getWebviewId()}`,
                progressBar = new ProgressBar(webviewId),
                lifetime = new DialogLifetime(),
                optionsContainer = document.createElement('div');

            if (fromPanel === undefined && this.webviews.size !== 0) {
                fromPanel = Array.from(this.webviews.values()).at(-1).fromPanel;
            }

            const activeWebview = this.getActiveWebview();
            const tabId = !fromPanel && activeWebview ? Number(activeWebview.tab_id) : null;

            this.webviews.set(webviewId, {
                divContainer: dialogContainer,
                webview: webview,
                fromPanel: fromPanel,
                tabId: tabId,
                progressBar,
                lifetime
            });
            lifetime.add(() => progressBar.destroy());
            lifetime.add(() => this.removeAssociatedTab(webviewId));

            // remove dialogs when tab is closed without closing dialogs
            if (!fromPanel) {
                const clearWebviews = closedTabId => {
                    if (tabId === closedTabId) {
                        this.webviews.forEach((view, key) => view.tabCloseListener === clearWebviews && this.removeDialog(key));
                    }
                };
                this.webviews.get(webviewId).tabCloseListener = clearWebviews;
                chrome.tabs.onRemoved.addListener(clearWebviews);
                lifetime.add(() => chrome.tabs.onRemoved.removeListener(clearWebviews));
            }

            //#region dialogTab properties
            dialogTab.setAttribute('class', 'dialog-tab');
            dialogTab.style.width = 85 - 5 * this.webviews.size + '%';
            dialogTab.style.height = 95 - 5 * this.webviews.size + '%';
            // keep hidden until anchored start is ready
            dialogTab.style.visibility = 'hidden';
            //#endregion

            //#region optionsContainer properties
            optionsContainer.setAttribute('class', 'options-container');

            const titleElement = document.createElement('span');
            titleElement.setAttribute('class', 'options-title');

            let pageTitle = UrlUtils.toDisplayText(linkUrl),
                showingOptions = false,
                hideOptionsTimeout,
                fadeTimeout;

            const renderTitle = () => {
                    titleElement.textContent = pageTitle;
                    titleElement.title = pageTitle;
                    optionsContainer.replaceChildren(titleElement);
                },
                setTitleText = title => {
                    pageTitle = UrlUtils.toDisplayText(title || webview.src || linkUrl);
                    if (!showingOptions) renderTitle();
                },
                showOptions = () => {
                    clearTimeout(hideOptionsTimeout);
                    clearTimeout(fadeTimeout);

                    if (showingOptions) return;

                    optionsContainer.classList.add('fade-out');
                    fadeTimeout = setTimeout(() => {
                        if (lifetime.signal.aborted) return;
                        optionsContainer.replaceChildren();
                        this.showWebviewOptions(webviewId, optionsContainer);
                        optionsContainer.classList.add('showing-options');
                        optionsContainer.classList.remove('fade-out');
                        showingOptions = true;
                    }, this.ANIMATION_DURATIONS.OPTIONS_FADE);
                },
                showTitle = () => {
                    clearTimeout(hideOptionsTimeout);
                    clearTimeout(fadeTimeout);

                    if (!showingOptions) {
                        renderTitle();
                        optionsContainer.classList.remove('showing-options');
                        optionsContainer.classList.remove('fade-out');
                        return;
                    }

                    hideOptionsTimeout = setTimeout(() => {
                        if (!showingOptions) return;

                        optionsContainer.classList.add('fade-out');
                        fadeTimeout = setTimeout(() => {
                            if (lifetime.signal.aborted) return;
                            renderTitle();
                            optionsContainer.classList.remove('showing-options');
                            optionsContainer.classList.remove('fade-out');
                            showingOptions = false;
                        }, this.ANIMATION_DURATIONS.OPTIONS_FADE);
                    }, this.ANIMATION_DURATIONS.OPTIONS_HIDE);
                };

            renderTitle();

            lifetime.add(() => {
                clearTimeout(hideOptionsTimeout);
                clearTimeout(fadeTimeout);
            });

            optionsContainer.addEventListener('mouseenter', showOptions, {signal: lifetime.signal});
            optionsContainer.addEventListener('mouseleave', showTitle, {signal: lifetime.signal});
            //#endregion

            //#region webview properties
            webview.id = webviewId;
            webview.className = 'dialog-page-webview';
            new DialogFullscreen(webview, lifetime);

            let titleFetchTimeout;
            lifetime.add(() => clearTimeout(titleFetchTimeout));

            webview.addEventListener(
                'loadstart',
                () => {
                    webview.style.backgroundColor = 'var(--colorBorder)';
                    progressBar.start();
                    setTitleText(webview.src || linkUrl);

                    const input = document.getElementById(`input-${webview.id}`);
                    if (input !== null) {
                        input.value = webview.src;
                    }
                },
                {signal: lifetime.signal}
            );
            webview.addEventListener(
                'loadcommit',
                event => {
                    setTitleText(webview.src || linkUrl);
                    dialogTab.querySelector('.reader-view-toggle')?.setAttribute('aria-pressed', String(ReaderView.isReaderUrl(event.url || webview.src)));
                },
                {signal: lifetime.signal}
            );
            webview.addEventListener(
                'loadstop',
                () => {
                    progressBar.clear(true);

                    const expectedSrc = webview.src;
                    clearTimeout(titleFetchTimeout);
                    titleFetchTimeout = setTimeout(() => {
                        if (lifetime.signal.aborted) return;
                        this.fetchWebviewTitle(webview, expectedSrc, setTitleText);
                    }, TIMING_CONFIG.titleFetchDelay);
                },
                {signal: lifetime.signal}
            );
            fromPanel && webview.addEventListener('mousedown', event => event.stopPropagation(), {signal: lifetime.signal});
            //#endregion

            //#region dialogContainer properties
            dialogContainer.setAttribute('class', 'dialog-container');

            const pointerX = origin?.x ?? window.innerWidth / 2;
            const pointerY = origin?.y ?? window.innerHeight / 2;
            dialogContainer.dataset.pointerX = String(pointerX);
            dialogContainer.dataset.pointerY = String(pointerY);

            const stopEvent = event => {
                event.preventDefault();
                event.stopPropagation();

                if (event.target.id === `input-${webviewId}`) {
                    const inputElement = event.target;

                    // Calculate the cursor position based on the click location
                    const offsetX = event.clientX - inputElement.getBoundingClientRect().left;

                    // Use cached canvas context for text measurement (performance)
                    this.#canvasContext.font = window.getComputedStyle(inputElement).font;

                    // Measure the width of the text up to each character
                    let cursorPosition = 0,
                        textWidth = 0;
                    for (let i = 0; i < inputElement.value.length; i++) {
                        const charWidth = this.#canvasContext.measureText(inputElement.value[i]).width;
                        if (textWidth + charWidth > offsetX) {
                            cursorPosition = i;
                            break;
                        }
                        textWidth += charWidth;
                        cursorPosition = i + 1;
                    }

                    // Manually focus the input element and set the cursor position
                    inputElement.focus({preventScroll: true});
                    inputElement.setSelectionRange(cursorPosition, cursorPosition);
                }
            };

            if (fromPanel) {
                document.body.addEventListener('pointerdown', stopEvent, {signal: lifetime.signal});
            }

            dialogContainer.addEventListener(
                'click',
                event => {
                    if (event.target === dialogContainer) {
                        this.removeDialog(webviewId);
                    }
                },
                {signal: lifetime.signal}
            );

            //#endregion

            dialogTab.appendChild(optionsContainer);
            dialogTab.appendChild(progressBar.element);
            const content = document.createElement('div');
            content.className = 'dialog-page-content';
            content.append(ReaderView.createControls(webview, lifetime.signal), webview);
            dialogTab.appendChild(content);

            dialogContainer.appendChild(dialogTab);

            this.prepareDialogWebview(webview, webviewId, linkUrl, lifetime).then(success => {
                if (lifetime.signal.aborted || !success) {
                    this.cleanupDialog(webviewId);
                    this.webviews.delete(webviewId);
                    return;
                }

                (fromPanel ? document.querySelector('#browser') : document.querySelector('.active.visible.webpageview')).appendChild(dialogContainer);

                requestAnimationFrame(() => {
                    if (lifetime.signal.aborted) return;
                    this.setAnchoredTransformVars(dialogTab, pointerX, pointerY);
                    dialogTab.style.visibility = 'visible';
                    dialogContainer.classList.add('is-open');
                    dialogTab.classList.add('animating-open');

                    const onOpenEnd = e => {
                        if (e.animationName === 'dialog-tab-open-anchored') {
                            dialogTab.classList.remove('animating-open');
                        }
                    };
                    dialogTab.addEventListener('animationend', onOpenEnd, {signal: lifetime.signal});
                });
            });
        }

        prepareDialogWebview(webview, webviewId, linkUrl, lifetime) {
            return this.createRelatedTab(webviewId, linkUrl, lifetime).then(tab => {
                if (!tab?.id) return false;

                const tabId = String(tab.id);
                this.webviews.get(webviewId).relatedTabId = tab.id;
                webview.tab_id = tabId;
                webview.setAttribute('tab_id', tabId);
                webview.setAttribute('parent_tab_id', '0');
                webview.setAttribute('name', 'vivaldi-dialog');
                return true;
            });
        }

        createRelatedTab(webviewId, linkUrl, lifetime) {
            const panelId = `${webviewId}tabId`;
            return new Promise(resolve => {
                // Vivaldi web panels use this related-tab pattern. It keeps the
                // page out of the tab bar while still giving extensions a real tab.
                chrome.tabs.create(
                    {
                        url: linkUrl,
                        active: false,
                        windowId: vivaldiWindowId,
                        vivExtData: JSON.stringify({panelId})
                    },
                    tab => {
                        if (chrome.runtime.lastError || !tab?.id) {
                            console.debug('Dialog mod: Failed to create related tab:', chrome.runtime.lastError);
                            resolve(null);
                            return;
                        }

                        if (lifetime.signal.aborted) {
                            chrome.tabs.remove(tab.id);
                            resolve(null);
                            return;
                        }

                        resolve(tab);
                    }
                );
            });
        }

        /**
         * Compute anchored translate for the current layout so that the dialog
         * grows exactly from (viewportX, viewportY) when scaling from s0 → 1.
         * We precompute the starting translation T0 = (1 - s0) * (P - L).
         */
        setAnchoredTransformVars(dialogTab, viewportX, viewportY, s0 = 0.1) {
            const rect = dialogTab.getBoundingClientRect();
            const dx = viewportX - rect.left;
            const dy = viewportY - rect.top;
            const t0x = (1 - s0) * dx;
            const t0y = (1 - s0) * dy;

            dialogTab.style.setProperty('--s0', String(s0));
            dialogTab.style.setProperty('--tx0', `${t0x}px`);
            dialogTab.style.setProperty('--ty0', `${t0y}px`);

            return {t0x, t0y, s0};
        }

        fetchWebviewTitle(webview, expectedSrc, setTitleText) {
            try {
                let title = '';
                if (webview.getTitle) {
                    title = webview.getTitle();
                }

                if (title) {
                    if (webview.src === expectedSrc) setTitleText(title);
                    return;
                }

                webview.executeScript({code: 'document.title'}, results => {
                    if (chrome.runtime.lastError || webview.src !== expectedSrc) return;

                    const resolvedTitle = results?.[0];
                    if (resolvedTitle) setTitleText(resolvedTitle);
                });
            } catch (error) {
                console.debug('Dialog mod: Failed to fetch page title:', error);
            }
        }

        /**
         * Displays open in tab buttons and current url in input element
         * @param {string} webviewId is the id of the webview
         * @param {Object} thisElement the current instance divOptionContainer (div) element
         */
        showWebviewOptions(webviewId, thisElement) {
            let inputId = `input-${webviewId}`,
                data = this.webviews.get(webviewId),
                webview = data ? data.webview : undefined,
                signal = data?.lifetime?.signal;
            if (webview) {
                let input = null;

                if (UI_CONFIG.showUrlInput) {
                    input = document.createElement('input');
                    input.value = webview.src;
                    input.id = inputId;
                    input.setAttribute('class', 'dialog-input');

                    input.addEventListener(
                        'keydown',
                        async event => {
                            if (event.key === 'Enter') {
                                const value = input.value;
                                await this.navigateWebview(webview, await UrlUtils.normalizeOrSearch(value, this.searchEngineUtils));
                            }
                        },
                        {signal}
                    );
                }

                const fragment = document.createDocumentFragment(),
                    buttons = [
                        {content: this.iconUtils.back, action: () => this.navigateWebviewHistory(webview, 'back'), tooltip: TOOLTIP_CONFIG.back},
                        {content: this.iconUtils.forward, action: () => this.navigateWebviewHistory(webview, 'forward'), tooltip: TOOLTIP_CONFIG.forward},
                        {content: this.iconUtils.reload, action: () => webview.reload(), tooltip: TOOLTIP_CONFIG.reload},
                        {
                            content: this.iconUtils.readerView,
                            action: this.showReaderView.bind(this, webview),
                            cls: 'reader-view-toggle',
                            tooltip: TOOLTIP_CONFIG.readerView,
                            pressed: ReaderView.isReaderUrl(webview.src)
                        },
                        {
                            content: this.iconUtils.newTab,
                            action: () => (UI_CONFIG.showUrlInput ? this.openNewTab(inputId, true) : this.openNewTabFromWebview(webview, true)),
                            tooltip: TOOLTIP_CONFIG.newTab
                        },
                        {
                            content: this.iconUtils.backgroundTab,
                            action: () => (UI_CONFIG.showUrlInput ? this.openNewTab(inputId, false) : this.openNewTabFromWebview(webview, false)),
                            tooltip: TOOLTIP_CONFIG.backgroundTab
                        }
                    ];

                buttons.forEach(button => {
                    const element = this.createOptionsButton(button.content, button.action, button.cls || '', button.tooltip, signal);
                    if (button.pressed !== undefined) element.setAttribute('aria-pressed', String(button.pressed));
                    fragment.appendChild(element);
                });
                if (input) fragment.appendChild(input);

                thisElement.append(fragment);
            }
        }

        /**
         * Create a button with default style for the web view options.
         * @param {Node | string} content the content of the button to display
         * @param {Function} clickListenerCallback the click listeners callback function
         * @param {string} cls optional additional class for the button
         * @param {string} tooltip optional tooltip text
         * @param {AbortSignal} signal optional lifetime signal
         */
        createOptionsButton(content, clickListenerCallback, cls = '', tooltip = '', signal = undefined) {
            const button = document.createElement('button');
            button.setAttribute('class', `options-button ${cls}`.trim());
            if (tooltip) button.dataset.tooltip = tooltip;
            button.addEventListener('click', clickListenerCallback, {signal});

            if (typeof content === 'string') {
                button.innerHTML = content;
            } else {
                button.appendChild(content);
            }

            return button;
        }

        /**
         * Returns a unique, collision-resistant id.
         * Uses crypto.randomUUID() for uniqueness.
         */
        getWebviewId() {
            return crypto.randomUUID();
        }

        /**
         * Sets the webviews content to a reader version
         *
         * @param {webview} webview the webview to update
         */
        async showReaderView(webview) {
            try {
                await ReaderView.toggle(webview);
            } catch (error) {
                console.debug('Dialog mod: Failed to toggle native reader:', error);
            }
        }

        async navigateWebview(webview, url) {
            webview.src = url;
        }

        async navigateWebviewHistory(webview, direction) {
            if (direction === 'back') {
                webview.back();
            } else if (direction === 'forward') {
                webview.forward();
            }
        }

        /**
         * Opens a new Chrome tab with specified active boolean value
         * @param {string} inputId is the id of the input containing current url
         * @param {boolean} active indicates whether the tab is active or not (background tab)
         */
        async openNewTab(inputId, active) {
            const url = document.getElementById(inputId).value;
            chrome.tabs.create({url: await UrlUtils.normalizeOrSearch(url, this.searchEngineUtils), active: active});
        }

        openNewTabFromWebview(webview, active) {
            chrome.tabs.create({url: webview.src, active: active});
        }
    }

    class UrlUtils {
        static VALID_URL_PREFIXES = ['http://', 'https://', 'file://', 'vivaldi://', 'chrome://', 'chrome-extension://', 'data:', 'blob:'];
        static BLOCKED_SCHEMES = ['javascript:', 'vbscript:'];

        static isValid(url) {
            if (!url || typeof url !== 'string') return false;

            const trimmedUrl = url.trim().toLowerCase();
            if (this.BLOCKED_SCHEMES.some(scheme => trimmedUrl.startsWith(scheme))) return false;
            if (trimmedUrl.startsWith('about:')) return true;

            return this.VALID_URL_PREFIXES.some(prefix => trimmedUrl.startsWith(prefix));
        }

        static async normalizeOrSearch(input, searchEngineUtils) {
            if (this.isValid(input)) return input.trim();

            const searchRequest = await vivaldi.searchEngines.getSearchRequest(searchEngineUtils.defaultSearchId, input);
            return searchRequest.url;
        }

        static toDisplayText(value) {
            if (!value || typeof value !== 'string') return '';

            try {
                const url = new URL(value);
                if (!['http:', 'https:'].includes(url.protocol)) return value;

                return url.origin;
            } catch (error) {
                return value;
            }
        }
    }

    class WebviewLinkInteractionUtils {
        watchedWebviews = new WeakSet();
        targetUrls = new WeakMap();
        activeMiddleHold = null;

        constructor(getWebviewFromPanel, openDialog, timingConfig) {
            this.getWebviewFromPanel = getWebviewFromPanel;
            this.openDialog = openDialog;
            this.timingConfig = timingConfig;

            this.prepareOpenWebviews();
            this.observeWebviews();
        }

        prepareOpenWebviews() {
            document.querySelectorAll('webview[tab_id]').forEach(webview => this.prepareWebview(webview));
        }

        observeWebviews() {
            const root = document.getElementById('browser') || document.body;
            if (!root) return;

            const prepareNode = node => {
                if (!(node instanceof Element)) return;

                if (node.matches('webview[tab_id]')) {
                    this.prepareWebview(node);
                }

                node.querySelectorAll?.('webview[tab_id]').forEach(webview => this.prepareWebview(webview));
            };

            new MutationObserver(mutations => {
                mutations.forEach(mutation => {
                    if (mutation.type === 'attributes') {
                        prepareNode(mutation.target);
                        return;
                    }

                    mutation.addedNodes.forEach(prepareNode);
                });
            }).observe(root, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['tab_id']
            });
        }

        prepareWebview(webview) {
            if (this.watchedWebviews.has(webview)) return;

            this.watchedWebviews.add(webview);
            // targeturlchanged reports the link URL Vivaldi would show in the status bar,
            // so middle-click handling does not need code injected into every website.
            webview.addEventListener('targeturlchanged', event => this.#handleTargetUrlChanged(webview, event));
            webview.addEventListener('mousedown', event => this.#handleMouseDown(webview, event), true);
            webview.addEventListener('mouseup', event => this.#handleMouseUp(webview, event), true);
            webview.addEventListener('mouseleave', () => this.#cancelMiddleHold(webview), true);
            webview.addEventListener('dragstart', () => this.#cancelMiddleHold(webview), true);
        }

        #handleTargetUrlChanged(webview, event) {
            const url = event.newUrl || '';

            if (UrlUtils.isValid(url)) {
                this.targetUrls.set(webview, url);
            } else {
                this.targetUrls.delete(webview);
            }
        }

        #handleMouseDown(webview, event) {
            const url = this.targetUrls.get(webview);
            if (!url) return;

            const origin = {x: event.clientX, y: event.clientY};

            if (event.ctrlKey && event.altKey && [0, 1].includes(event.button)) {
                this.#cancelNativeClick(event);
                this.#openDialogFromWebview(webview, url, origin);
                return;
            }

            if (event.button !== 1) return;

            this.#cancelNativeClick(event);
            this.#cancelMiddleHold();

            const holdState = {
                webview,
                timer: setTimeout(() => {
                    holdState.opened = true;
                    this.#openDialogFromWebview(webview, url, origin);
                }, this.timingConfig.middleClickDelay),
                opened: false
            };

            this.activeMiddleHold = holdState;
        }

        #handleMouseUp(webview, event) {
            if (event.button !== 1) return;

            const holdState = this.activeMiddleHold;
            if (!holdState || holdState.webview !== webview) return;

            if (holdState.opened) this.#cancelNativeClick(event);
            this.#cancelMiddleHold(webview);
        }

        #cancelMiddleHold(webview = undefined) {
            const holdState = this.activeMiddleHold;
            if (!holdState || (webview && holdState.webview !== webview)) return;

            clearTimeout(holdState.timer);
            this.activeMiddleHold = null;
        }

        #openDialogFromWebview(webview, url, origin) {
            this.openDialog(url, this.getWebviewFromPanel(webview), origin);
        }

        #cancelNativeClick(event) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
        }
    }

    class DialogFullscreen {
        static exitInPage = function () {
            const root = document.documentElement;
            const active = root?.hasAttribute('data-dialog-fullscreen');
            const justExited = Date.now() - Number(root?.getAttribute('data-dialog-fullscreen-exited')) < 300;
            if (active) window.dispatchEvent(new Event('dialog-fullscreen-exit'));
            return active || justExited;
        };
        static EXIT_SCRIPT = `(${this.exitInPage.toString()})();`;

        constructor(webview, lifetime) {
            const inject = frameId => {
                const tabId = Number(webview.tab_id);
                if (lifetime.signal.aborted || !Number.isInteger(tabId) || tabId <= 0) return;
                // Override the methods in the player's own JavaScript world.
                chrome.scripting.executeScript({
                    target: Number.isInteger(frameId) ? {tabId, frameIds: [frameId]} : {tabId, allFrames: true},
                    world: 'MAIN', injectImmediately: true,
                    func: DialogFullscreen.installInPage
                }).catch(error => console.debug('Dialog mod: Fullscreen injection failed:', error));
            };
            const onCommitted = details => {
                if (details.tabId === Number(webview.tab_id)) inject(details.frameId);
            };
            chrome.webNavigation.onCommitted.addListener(onCommitted);
            lifetime.add(() => chrome.webNavigation.onCommitted.removeListener(onCommitted));
            for (const event of ['webcontentscreated', 'loadcommit', 'contentload', 'loadstop']) {
                webview.addEventListener(event, () => inject(), {signal: lifetime.signal});
            }
        }

        static installInPage = function () {
            if (window.__dialogFullscreenInstalled) return;
            window.__dialogFullscreenInstalled = true;
            const messageType = 'vivaldi-dialog-fullscreen';
            let active = null;
            let activeChild = null;
            let session = null;
            let restore = null;
            const style = document.createElement('style');
            style.textContent = `[data-dialog-fullscreen-player]:popover-open {
                position: fixed !important; inset: 0 !important;
                width: 100% !important; height: 100% !important;
                min-width: 0 !important; min-height: 0 !important;
                max-width: none !important; max-height: none !important;
                margin: 0 !important; padding: 0 !important; border: 0 !important;
                box-sizing: border-box !important; transform: none !important;
                background: black !important; overflow: hidden !important;
            }
            /* Popovers do not match the site's native video:fullscreen rules. */
            video[data-dialog-fullscreen-player]:popover-open {
                object-fit: contain !important; object-position: center !important;
                border-radius: 0 !important;
                -webkit-mask-image: none !important; mask-image: none !important;
            }`;
            const notify = element => (element.isConnected ? element : document)
                .dispatchEvent(new Event('fullscreenchange', {bubbles: true, composed: true}));
            const send = (target, action, sessionId, fromEscape = false) => {
                target.postMessage({type: messageType, action, session: sessionId, fromEscape}, '*');
            };
            const observer = new MutationObserver(() => getActive());
            const exit = ({fromEscape = false, notifyParent = true, notifyChild = true} = {}) => {
                if (!active) return Promise.resolve();
                const element = active, child = activeChild, endedSession = session;
                active = activeChild = session = null;
                observer.disconnect();
                restore();
                restore = null;
                document.documentElement.removeAttribute('data-dialog-fullscreen');
                if (fromEscape) {
                    document.documentElement.setAttribute('data-dialog-fullscreen-exited', String(Date.now()));
                } else {
                    document.documentElement.removeAttribute('data-dialog-fullscreen-exited');
                }
                if (notifyChild && child) send(child.window, 'exit', child.session, fromEscape);
                if (notifyParent && window.parent !== window) send(window.parent, 'exit', endedSession, fromEscape);
                notify(element);
                return Promise.resolve();
            };
            // A removed or externally hidden popover must not leave stale API state.
            const getActive = () => {
                if (active && (!active.isConnected || !active.matches(':popover-open'))) exit();
                return active;
            };
            const enter = (element, child = null) => {
                if (!element.isConnected) return Promise.reject(new TypeError('Fullscreen element is detached'));
                if (getActive() === element) {
                    if (child) activeChild = child;
                    return Promise.resolve();
                }
                if (active) exit();
                const root = element.getRootNode();
                // Document styles cannot cross shadow boundaries.
                (root === document ? document.documentElement : root).append(style);
                const popover = element.getAttribute('popover');
                const marker = element.getAttribute('data-dialog-fullscreen-player');
                const wasOpen = element.matches(':popover-open');
                const onToggle = () => getActive();
                const onFrameLoad = () => exit();
                const reset = () => {
                    element.removeEventListener('toggle', onToggle);
                    element.removeEventListener('load', onFrameLoad);
                    if (element.matches(':popover-open')) element.hidePopover();
                    if (marker === null) element.removeAttribute('data-dialog-fullscreen-player');
                    else element.setAttribute('data-dialog-fullscreen-player', marker);
                    if (popover === null) element.removeAttribute('popover');
                    else element.setAttribute('popover', popover);
                    style.remove();
                    if (wasOpen && element.isConnected) element.showPopover();
                };
                element.setAttribute('popover', 'manual');
                element.setAttribute('data-dialog-fullscreen-player', '');
                try {
                    element.showPopover();
                    if (!element.matches(':popover-open')) throw new Error('Fullscreen popover was cancelled');
                } catch (error) {
                    reset();
                    return Promise.reject(error);
                }
                active = element;
                activeChild = child;
                // Sessions prevent delayed exits for a previous player closing its replacement.
                session = `${Date.now()}:${Math.random()}`;
                restore = reset;
                element.addEventListener('toggle', onToggle);
                if (child) element.addEventListener('load', onFrameLoad);
                // Observe the document and every enclosing shadow root, including closed roots.
                for (let observedRoot = root; observedRoot; observedRoot = observedRoot.host?.getRootNode()) {
                    observer.observe(observedRoot, {childList: true, subtree: true, attributes: true, attributeFilter: ['popover']});
                }
                document.documentElement.setAttribute('data-dialog-fullscreen', '');
                document.documentElement.removeAttribute('data-dialog-fullscreen-exited');
                if (window.parent !== window) send(window.parent, 'enter', session);
                notify(element);
                return Promise.resolve();
            };
            Element.prototype.requestFullscreen = function () { return enter(this); };
            const fullscreenElement = root => {
                let candidate = getActive();
                while (candidate) {
                    const candidateRoot = candidate.getRootNode();
                    if (candidateRoot === root) return candidate;
                    candidate = candidateRoot.host;
                }
                return null;
            };
            Object.defineProperty(document, 'fullscreenElement', {configurable: true, get: () => fullscreenElement(document)});
            Object.defineProperty(ShadowRoot.prototype, 'fullscreenElement', {
                configurable: true, get() { return fullscreenElement(this); }
            });
            // Steam checks this older boolean before deciding whether to exit.
            Object.defineProperty(document, 'fullscreen', {configurable: true, get: () => Boolean(getActive())});
            document.exitFullscreen = () => exit();

            const findFrame = (root, source) => {
                for (const frame of root.querySelectorAll('iframe, frame')) {
                    if (frame.contentWindow === source) return frame;
                }
                for (const element of root.querySelectorAll('*')) {
                    if (!element.shadowRoot) continue;
                    const frame = findFrame(element.shadowRoot, source);
                    if (frame) return frame;
                }
                return null;
            };
            window.addEventListener('message', event => {
                const message = event.data;
                if (message?.type !== messageType || typeof message.session !== 'string' || !event.source) return;
                if (window.parent !== window && event.source === window.parent) {
                    if (message.action === 'exit' && message.session === session) {
                        exit({fromEscape: message.fromEscape === true, notifyParent: false});
                    }
                } else if (message.action === 'enter') {
                    // Compare WindowProxy identities; this also works across origins.
                    const frame = findFrame(document, event.source);
                    if (!frame) return;
                    enter(frame, {window: event.source, session: message.session})
                        .catch(() => send(event.source, 'exit', message.session));
                } else if (message.action === 'exit' && activeChild?.window === event.source && activeChild.session === message.session) {
                    exit({fromEscape: message.fromEscape === true, notifyChild: false});
                }
            });
            window.addEventListener('dialog-fullscreen-exit', () => exit({fromEscape: true}));
            window.addEventListener('pagehide', () => exit());
            window.addEventListener('keydown', event => {
                if (event.key !== 'Escape' || !getActive()) return;
                event.preventDefault();
                event.stopImmediatePropagation();
                exit({fromEscape: true});
            }, true);
        };
    }

    class WebsiteInjectionUtils {
        watchedWebviews = new WeakSet();

        constructor(getWebviewFromPanel, openDialog, iconConfig, timingConfig) {
            this.getWebviewFromPanel = getWebviewFromPanel;
            this.linkInteractionConfig = JSON.stringify({
                icon: iconConfig,
                timing: timingConfig
            });

            // Inject into webviews that already exist and keep watching for new ones.
            // This avoids relying on webNavigation tab IDs, which do not always map
            // reliably back to Vivaldi's DOM webview elements.
            this.prepareOpenWebviews();
            this.observeWebviews();

            // React on demand to open a dialog.
            chrome.runtime.onMessage.addListener(message => {
                if (message.url) {
                    openDialog(message.url, message.fromPanel, message.origin);
                }
            });
        }

        prepareOpenWebviews() {
            document.querySelectorAll('webview[tab_id]').forEach(webview => this.prepareWebview(webview));
        }

        observeWebviews() {
            const root = document.getElementById('browser') || document.body;
            if (!root) return;

            const prepareNode = node => {
                if (!(node instanceof Element)) return;

                if (node.matches('webview[tab_id]')) {
                    this.prepareWebview(node);
                }

                node.querySelectorAll?.('webview[tab_id]').forEach(webview => this.prepareWebview(webview));
            };

            new MutationObserver(mutations => {
                mutations.forEach(mutation => {
                    if (mutation.type === 'attributes') {
                        prepareNode(mutation.target);
                        return;
                    }

                    mutation.addedNodes.forEach(prepareNode);
                });
            }).observe(root, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['tab_id']
            });
        }

        prepareWebview(webview) {
            if (this.watchedWebviews.has(webview)) return;

            this.watchedWebviews.add(webview);

            // A full navigation creates a new page context, so inject again once it
            // has finished loading. SPA/hash navigation keeps the existing handler.
            webview.addEventListener('loadstop', () => this.injectCode(webview));

            // Also try immediately so tabs that were already loaded before this mod
            // initialized receive the handler without requiring a reload.
            this.injectCode(webview);
        }

        injectCode(webview) {
            const fromPanel = this.getWebviewFromPanel(webview),
                handler = WebsiteLinkInteractionHandler.toString(),
                instantiationCode = `
                if (!this.dialogEventListenerSet) {
                    new (${handler})(${fromPanel}, ${this.linkInteractionConfig});
                    this.dialogEventListenerSet = true;
                }
            `;

            try {
                webview.executeScript({code: instantiationCode, allFrames: true}, () => {
                    if (chrome.runtime.lastError) {
                        // Expected for pages/frames where script injection is not allowed.
                        console.debug('Dialog mod: Script injection failed:', chrome.runtime.lastError.message);
                    }
                });
            } catch (error) {
                console.debug('Dialog mod: Failed to execute script:', error);
            }
        }
    }

    class WebsiteLinkInteractionHandler {
        constructor(fromPanel, config) {
            this.fromPanel = fromPanel;
            this.config = config;
            this.iconConfig = config.icon;
            this.timingConfig = config.timing;
            this.icon = null;
            this.boundHideIcon = this.#hideLinkIcon.bind(this);
            this.timers = {showIcon: null, showDialog: null, hideIcon: null};

            this.#initialize();
        }

        #initialize() {
            if (this.iconConfig.linkIcon) {
                this.#setupIconHandling();
            }
        }

        #setupIconHandling() {
            this.#createIcon();
            this.#createIconStyle();

            document.addEventListener('mouseover', event => {
                const link = this.#getLinkElement(event);
                if (!link) return;

                clearTimeout(this.timers.showIcon);
                clearTimeout(this.timers.hideIcon);

                this.timers.showIcon = setTimeout(() => {
                    if (!link.isConnected) return;

                    requestAnimationFrame(() => {
                        const rect = link.getBoundingClientRect();
                        Object.assign(this.icon.style, {
                            display: 'block',
                            left: `${rect.right + 5}px`,
                            top: `${rect.top + window.scrollY}px`
                        });
                    });

                    this.icon.dataset.targetUrl = link.href;
                    this.currentLinkEl = link;

                    link.addEventListener('mouseleave', this.boundHideIcon);
                }, this.iconConfig.showIconDelay);
            });
        }

        #createIcon() {
            const icon = document.createElement('div');

            // Render the configured icon as a self-contained inline SVG so the
            // website does not need to provide an icon font or stylesheet.
            icon.className = 'link-icon';
            icon.dataset.iconName = this.iconConfig.linkIcon;
            icon.innerHTML = this.#getLinkIconSvg(this.iconConfig.linkIcon);
            icon.style.display = 'none';

            const getLinkCenter = () => {
                const el = this.currentLinkEl;
                if (el) {
                    const r = el.getBoundingClientRect();
                    return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)};
                }
                return {x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2)};
            };

            if (this.iconConfig.linkIconInteractionOnHover) {
                icon.addEventListener('mouseenter', () => {
                    clearTimeout(this.timers.hideIcon);
                    this.timers.showDialog = setTimeout(() => {
                        const {x, y} = getLinkCenter();
                        this.#sendDialogMessage(this.icon.dataset.targetUrl, x, y);
                    }, this.iconConfig.showDialogOnHoverDelay);
                });
                icon.addEventListener('mouseleave', () => {
                    clearTimeout(this.timers.showDialog);
                    this.#hideLinkIcon();
                });
            } else {
                icon.addEventListener('click', () => {
                    const {x, y} = getLinkCenter();
                    this.#sendDialogMessage(this.icon.dataset.targetUrl, x, y);
                });
                icon.addEventListener('mouseenter', () => clearTimeout(this.timers.hideIcon));
                icon.addEventListener('mouseleave', this.boundHideIcon);
            }

            this.icon = icon;
            document.body.appendChild(this.icon);
        }

        #getLinkIconSvg(iconName) {
            const icons = {
                'arrow-up-right':
                    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42 9.3-9.29H14V3ZM5 5h6v2H5v12h12v-6h2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/></svg>',
                'info-circle':
                    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 4.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5ZM10.75 11h2.5v6h-2.5v-6Z"/></svg>',
                'square-outline':
                    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/></svg>'
            };

            return icons[iconName] || icons['arrow-up-right'];
        }

        #hideLinkIcon() {
            clearTimeout(this.timers.showIcon);
            this.timers.hideIcon = setTimeout(
                () => {
                    this.icon.style.display = 'none';
                },
                this.iconConfig.linkIconInteractionOnHover ? 300 : 600
            );
        }

        #getLinkElement(event) {
            const getAnchor = node => {
                if (node instanceof HTMLAnchorElement && node.getAttribute('href') !== '#') return node;
                if (node instanceof Element) return node.closest('a[href]:not([href="#"])');
            };

            const pathLink = (event.composedPath?.() || []).map(getAnchor).find(Boolean);
            return pathLink || getAnchor(event.target);
        }

        #sendDialogMessage(url, x, y) {
            chrome.runtime.sendMessage({url, fromPanel: this.fromPanel, origin: {x, y}});
        }

        #createIconStyle() {
            const style = document.createElement('style');
            style.textContent = `
                .link-icon {
                    position: absolute;
                    box-sizing: border-box;
                    width: 22px;
                    height: 22px;
                    padding: 3px;
                    border: 1px solid rgba(0, 0, 0, 0.18);
                    border-radius: 4px;
                    background: rgba(255, 255, 255, 0.96);
                    color: #3c4043;
                    box-shadow: 0 2px 5px rgba(0, 0, 0, 0.18);
                    cursor: pointer;
                    z-index: 2147483647;
                    transition: opacity 0.2s ease;
                }

                .link-icon svg {
                    display: block;
                    width: 100%;
                    height: 100%;
                    fill: currentColor;
                    pointer-events: none;
                }

                .link-icon:hover {
                    opacity: 0.9;
                }
            `;
            document.head.appendChild(style);
        }
    }

    /**
     * Utility class for adding and updating context menu items
     */
    class SearchEngineUtils {
        /**
         * Constructor for SearchEngineUtils
         * @param {Function} openLinkCallback - Callback for opening links
         * @param {Function} searchCallback - Callback for searching
         * @param {Object} [config={}] - Configuration options
         * @param {string} [config.menuPrefix] - Prefix for the context menu item
         * @param {string} [config.linkMenuTitle] - Titel for the link menu
         * @param {string} [config.searchMenuTitle] - title for the search menu
         * @param {string} [config.selectSearchMenuTitle] - title for the select search menu
         */
        constructor(openLinkCallback, searchCallback, config = {}) {
            this.openLinkCallback = openLinkCallback;
            this.searchCallback = searchCallback;

            this.menuPrefix = config.menuPrefix;
            this.linkMenuTitle = config.linkMenuTitle;
            this.searchMenuTitle = config.searchMenuTitle;
            this.selectSearchMenuTitle = config.selectSearchMenuTitle;

            this.createdContextMenuMap = new Map();
            this.searchEngineCollection = [];
            this.defaultSearchId = null;
            this.privateSearchId = null;

            // Cache static IDs for frequent access
            this.LINK_ID = 'dialog-tab-link';
            this.SEARCH_ID = 'search-dialog-tab';
            this.SELECT_SEARCH_ID = 'select-search-dialog-tab';

            this.#initialize();
        }

        /**
         * Initializes the context menu and listeners
         * @returns {Promise<void>}
         */
        async #initialize() {
            // Create context menu items
            this.#createContextMenuOption();

            // Initialize search engines and context menus
            this.#updateSearchEnginesAndContextMenu();

            // Update context menus when search engines change
            vivaldi.searchEngines.onTemplateUrlsChanged.addListener(() => {
                this.#removeContextMenuSelectSearch();
                this.#updateSearchEnginesAndContextMenu();
            });
        }

        /**
         * Creates context menu items to open a dialog tab
         */
        #createContextMenuOption() {
            chrome.contextMenus.create({
                id: this.LINK_ID,
                title: this.#formatMenuTitle(this.linkMenuTitle),
                contexts: ['link']
            });
            chrome.contextMenus.create({
                id: this.SEARCH_ID,
                title: this.#formatMenuTitle(this.searchMenuTitle),
                contexts: ['selection']
            });
            chrome.contextMenus.create({
                id: this.SELECT_SEARCH_ID,
                title: this.#formatMenuTitle(this.selectSearchMenuTitle),
                contexts: ['selection']
            });

            chrome.contextMenus.onClicked.addListener(itemInfo => {
                const {menuItemId, parentMenuItemId, linkUrl, selectionText} = itemInfo;

                if (menuItemId === this.LINK_ID) {
                    this.openLinkCallback(linkUrl);
                } else if (menuItemId === this.SEARCH_ID) {
                    const engineId = window.incognito ? this.privateSearchId : this.defaultSearchId;
                    this.searchCallback(engineId, selectionText);
                } else if (parentMenuItemId === this.SELECT_SEARCH_ID) {
                    const engineId = menuItemId.substr(parentMenuItemId.length);
                    this.searchCallback(engineId, selectionText);
                }
            });
        }

        #formatMenuTitle(title) {
            return this.menuPrefix ? `${this.menuPrefix} ${title}` : title;
        }

        /**
         * Updates the search engines and context menu
         */
        async #updateSearchEnginesAndContextMenu() {
            const searchEngines = await vivaldi.searchEngines.getTemplateUrls();
            this.searchEngineCollection = searchEngines.templateUrls;
            this.defaultSearchId = searchEngines.defaultSearch;
            this.privateSearchId = searchEngines.defaultPrivate;

            this.#createContextMenuSelectSearch();
        }

        /**
         * Removes sub-context menu items for select search engine menu item
         */
        #removeContextMenuSelectSearch() {
            this.createdContextMenuMap.forEach((_, engineId) => {
                const menuId = this.SELECT_SEARCH_ID + engineId;
                chrome.contextMenus.remove(menuId);
            });

            this.createdContextMenuMap.clear();
        }

        /**
         * Creates sub-context menu items for select search engine menu item
         */
        #createContextMenuSelectSearch() {
            this.searchEngineCollection.forEach(engine => {
                if (!this.createdContextMenuMap.has(engine.guid)) {
                    chrome.contextMenus.create({
                        id: this.SELECT_SEARCH_ID + engine.guid,
                        parentId: this.SELECT_SEARCH_ID,
                        title: engine.name,
                        contexts: ['selection']
                    });
                    this.createdContextMenuMap.set(engine.guid, true);
                }
            });
        }
    }

    class ReaderView {
        static STYLE_PREF = 'vivaldi.webpages.reader.style';
        static #native;
        static #actionsKey = Symbol.for('dialog.mod.nativeReaderActions');

        static createControls(webview, signal) {
            const root = document.createElement('div');
            root.className = 'dialog-reader-controls';
            root.hidden = true;
            let mounted;
            const dispose = () => {
                if (!mounted) return;
                const {renderer, actions} = mounted;
                mounted = undefined;
                try { renderer?.unmount(); }
                finally {
                    actions.views.delete(root);
                    if (actions.views.size === 0) actions.restore();
                }
            };
            webview.addEventListener('loadcommit', event => {
                if (event.isTopLevel === false) return;
                root.hidden = !ReaderView.isReaderUrl(event.url || webview.src);
                if (root.hidden) return dispose();
                if (mounted) return;
                try {
                    const native = ReaderView.getNativeControls(webview);
                    const actions = ReaderView.getNativeActions(native);
                    mounted = {actions};
                    actions.views.set(root, {webview, windowId: native.window.vivaldiWindowId});
                    mounted.renderer = native.ReactDOM.createRoot(root);
                    actions.api.setReaderModeStyle(native.window.vivaldiWindowId, Number(webview.tab_id));
                    mounted.renderer.render(native.React.createElement(native.context.Provider, {value: native.window},
                        native.React.createElement(native.element.type, {...native.element.props, pageId: Number(webview.tab_id)})));
                } catch (error) {
                    dispose();
                    console.debug('Dialog mod: Native reader controls unavailable:', error);
                }
            }, {signal});
            signal.addEventListener('abort', dispose, {once: true});
            window.addEventListener('unload', dispose, {once: true, signal});
            return root;
        }

        static getNativeControls(webview) {
            if (ReaderView.#native) return ReaderView.#native;
            const findControls = element => {
                if (!element || typeof element !== 'object') return;
                if (Array.isArray(element)) return element.map(findControls).find(Boolean);
                const type = element.type?.type || element.type;
                if (typeof type === 'function' && type.toString().includes('reader-settings-toggle')) return element;
                return findControls(element.props?.children);
            };
            for (const node of document.querySelectorAll('.webpageview')) {
                let fiber = node[Object.keys(node).find(key => key.startsWith('__reactFiber'))];
                let view, container;
                for (; fiber; fiber = fiber.return) {
                    if (!view && fiber.stateNode?.render?.toString().includes('webpageview')) view = fiber.stateNode;
                    if (fiber.stateNode?.containerInfo) container = fiber.stateNode.containerInfo;
                }
                if (!view || !container) continue;
                // Read a render description to obtain the original component without changing the native view.
                const preview = Object.assign(Object.create(view), {
                    props: {...view.props, id: Number(webview.tab_id), url: 'chrome://reader/',
                        prefValues: {...view.props.prefValues, 'vivaldi.webpages.reader.controls': true}},
                    state: {...view.state, dockingState: 'off'}
                });
                const element = findControls(preview.render());
                if (!element || !view.constructor.contextType?.Provider) continue;
                const core = (container.ownerDocument || container).defaultView;
                let require;
                core.webpackChunkgapp_browser_react.push([[`dialog-reader-${crypto.randomUUID()}`], {}, runtime => { require = runtime; }]);
                const moduleWith = marker => {
                    const id = Object.keys(require.m).find(id => require.m[id].toString().includes(marker));
                    if (!id) throw new Error(`Vivaldi module unavailable: ${marker}`);
                    return require(id);
                };
                const React = moduleWith('.createElement=function'), ReactDOM = moduleWith('.createRoot=function');
                if (typeof React?.createElement !== 'function' || typeof ReactDOM?.createRoot !== 'function') {
                    throw new Error('Vivaldi reader renderer unavailable');
                }
                return ReaderView.#native = {core, require, element, context: view.constructor.contextType, window: view.context, React, ReactDOM};
            }
            throw new Error('Vivaldi reader component not found');
        }

        static getNativeActions({core, require}) {
            if (core[ReaderView.#actionsKey]) return core[ReaderView.#actionsKey];
            const id = Object.keys(require.m).find(id => require.m[id].toString().includes('setReaderModeStyle:'));
            if (!id) throw new Error('Vivaldi reader actions not found');
            const api = Object.values(require(id)).find(value => typeof value?.setReaderModeStyle === 'function');
            const dependencies = [...require.m[id].toString().matchAll(/=[\w$]+\((\d+)\)/g)];
            const exports = dependencies.flatMap(match => Object.values(require(match[1])));
            const pages = exports.find(value => typeof value?.getPageById === 'function');
            const themes = exports.find(value => typeof value?.getReaderThemeColor === 'function');
            if (!api || !pages || typeof themes?.addListener !== 'function' || typeof themes?.removeListener !== 'function') {
                throw new Error('Vivaldi reader context unavailable');
            }
            const views = new Map(), original = api.setReaderModeStyle;
            const apply = function (windowId, pageId, ...args) {
                const dialog = [...views.values()].find(({webview}) => Number(webview.tab_id) === pageId);
                if (!dialog) return original.call(this, windowId, pageId, ...args);
                // Hidden panel tabs are absent from the native page store. Supply their context only during this reader call.
                const lookup = pages.getPageById, own = Object.hasOwn(pages, 'getPageById');
                pages.getPageById = function (id, ...args) {
                    return lookup.call(this, id, ...args) || (id === pageId ? {id, windowId, url: dialog.webview.src} : undefined);
                };
                try { return original.call(this, windowId, pageId, ...args); }
                finally {
                    if (own) pages.getPageById = lookup;
                    else delete pages.getPageById;
                }
            };
            const refresh = () => {
                for (const {webview, windowId} of views.values()) api.setReaderModeStyle(windowId, Number(webview.tab_id));
            };
            const restore = () => {
                try { themes.removeListener(refresh); }
                finally {
                    if (api.setReaderModeStyle === apply) api.setReaderModeStyle = original;
                    if (core[ReaderView.#actionsKey]?.apply === apply) delete core[ReaderView.#actionsKey];
                }
            };
            try {
                api.setReaderModeStyle = apply;
                themes.addListener(refresh);
                return core[ReaderView.#actionsKey] = {core, api, original, apply, themes, refresh, views, restore};
            } catch (error) {
                restore();
                throw error;
            }
        }

        static isReaderUrl(url) {
            return /^(?:chrome|vivaldi):\/\/reader\/?(?:[?#]|$)/.test(url || '');
        }

        static async toggle(webview) {
            const tabId = Number(webview.tab_id);
            if (!Number.isInteger(tabId) || tabId <= 0) return;

            // Use the related tab's current URL, including navigation from inside the reader.
            const tab = await chrome.tabs.get(tabId);
            const currentUrl = tab.pendingUrl || tab.url;
            const isReader = ReaderView.isReaderUrl(currentUrl);
            let article;
            try {
                const current = new URL(currentUrl);
                article = isReader ? new URL(current.searchParams.get('path')) : current;
            } catch { return; }
            if (!['http:', 'https:'].includes(article.protocol)) return;

            if (isReader) {
                const history = await new Promise(resolve => webview.getPageHistory((index, entries) => resolve({index, entries})));
                if (history.entries[history.index - 1]?.url === article.href) {
                    webview.back();
                    return;
                }
            }
            // This is the same internal page used by Vivaldi's native Reader View.
            const url = isReader ? article.href : `chrome://reader/?${new URLSearchParams({path: article.href})}`;
            await chrome.tabs.update(tabId, {url});
        }
    }

    class ProgressBar {
        static CLEAR_DELAY = 250; // Delay before hiding progress bar after completion
        static EASING = 0.08;

        constructor(webviewId) {
            this.webviewId = webviewId;
            this.progress = 0;
            this.animationFrame = null;
            this.clearTimeout = null;
            this.element = this.#createProgressBar(webviewId);
        }

        #createProgressBar(webviewId) {
            const progressBar = document.createElement('div');
            progressBar.setAttribute('class', 'progress-bar');
            progressBar.id = `progressBar-${webviewId}`;
            return progressBar;
        }

        start() {
            this.element.style.visibility = 'visible';
            this.element.classList.remove('is-complete');
            this.progress = 0;
            this.element.style.width = '0%';

            this.#animateTo(85);
        }

        #animateTo(target) {
            cancelAnimationFrame(this.animationFrame);

            const step = () => {
                this.progress += (target - this.progress) * ProgressBar.EASING;
                this.element.style.width = `${this.progress.toFixed(2)}%`;

                if (this.progress < target - 0.5) {
                    this.animationFrame = requestAnimationFrame(step);
                }
            };

            this.animationFrame = requestAnimationFrame(step);
        }

        clear(loadStop = false) {
            cancelAnimationFrame(this.animationFrame);
            clearTimeout(this.clearTimeout);
            this.element.classList.add('is-complete');

            if (loadStop) {
                this.element.style.width = '100%';

                this.clearTimeout = setTimeout(() => {
                    this.progress = 0;
                    this.element.style.visibility = 'hidden';
                    this.element.style.width = '0%';
                }, ProgressBar.CLEAR_DELAY);
            }
        }

        destroy() {
            cancelAnimationFrame(this.animationFrame);
            clearTimeout(this.clearTimeout);
            this.animationFrame = null;
            this.clearTimeout = null;
        }
    }

    /**
     * Utility class to manage SVG icons
     * @class
     */
    class IconUtils {
        // Static icons
        static SVG = {
            ellipsis:
                '<svg xmlns="http://www.w3.org/2000/svg" height="2em" viewBox="0 0 448 512"><path d="M8 256a56 56 0 1 1 112 0A56 56 0 1 1 8 256zm160 0a56 56 0 1 1 112 0 56 56 0 1 1 -112 0zm216-56a56 56 0 1 1 0 112 56 56 0 1 1 0-112z"/></svg>',
            readerView:
                '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="M3 4h10v1H3zM3 6h10v1H3zM3 8h10v1H3zM3 10h6v1H3z"></path></svg>',
            newTab: '<svg xmlns="http://www.w3.org/2000/svg" height="1em" viewBox="0 0 512 512"><path d="M320 0c-17.7 0-32 14.3-32 32s14.3 32 32 32h82.7L201.4 265.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L448 109.3V192c0 17.7 14.3 32 32 32s32-14.3 32-32V32c0-17.7-14.3-32-32-32H320zM80 32C35.8 32 0 67.8 0 112V432c0 44.2 35.8 80 80 80H400c44.2 0 80-35.8 80-80V320c0-17.7-14.3-32-32-32s-32-14.3-32-32V432c0 8.8-7.2 16-16 16H80c-8.8 0-16-7.2-16-16V112c0-8.8 7.2-16 16-16H192c17.7 0 32-14.3 32-32s-14.3-32-32-32H80z"/></svg>',
            backgroundTab:
                '<svg xmlns="http://www.w3.org/2000/svg" height="1em" viewBox="0 0 448 512"><path d="M384 32c35.3 0 64 28.7 64 64V416c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V96C0 60.7 28.7 32 64 32H384zM160 144c-13.3 0-24 10.7-24 24s10.7 24 24 24h94.1L119 327c-9.4 9.4-9.4 24.6 0 33.9s24.6 9.4 33.9 0l135-135V328c0 13.3 10.7 24 24 24s24-10.7 24-24V168c-13.3 0-24-10.7-24-24H160z"/></svg>'
        };

        // Vivaldi icons
        static VIVALDI_BUTTONS = [
            {
                name: 'back',
                buttonName: 'Back',
                fallback:
                    '<svg xmlns="http://www.w3.org/2000/svg" height="1em" viewBox="0 0 448 512"><path d="M9.4 233.4c-12.5 12.5-12.5 32.8 0 45.3l160 160c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L109.2 288 416 288c17.7 0 32-14.3 32-32s-14.3-32-32-32l-306.7 0L214.6 118.6c12.5-12.5 12.5-32.8 0-45.3L54.6 192z"/></svg>'
            },
            {
                name: 'forward',
                buttonName: 'Forward',
                fallback:
                    '<svg xmlns="http://www.w3.org/2000/svg" height="1em" viewBox="0 0 448 512"><path d="M438.6 278.6c12.5-12.5 12.5-32.8 0-45.3l-160-160c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0-45.3L338.8 224 32 224c-17.7 0-32 14.3-32 32s-14.3 32 32 32l306.7 0L233.4 393.4c-12.5 12.5-12.5 32.8 0 45.3l160-160z"/></svg>'
            },
            {
                name: 'reload',
                buttonName: 'Reload',
                fallback:
                    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M125.7 160H176c17.7 0 32 14.3 32 32s-14.3 32-32 32H48c-17.7 0-32-14.3-32-32V64c0-17.7 14.3-32 32-32s32 14.3 32 32v51.2L97.6 97.6c87.5-87.5 229.3-87.5 316.8 0s87.5 229.3 0 316.8s-229.3 87.5-316.8 0c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0c62.5 62.5 163.8 62.5 226.3 0s62.5-163.8 0-226.3s-163.8-62.5-226.3 0L125.7 160z"/></svg>'
            },
            {
                name: 'settings',
                buttonName: 'Settings',
                fallback: IconUtils.SVG.settings
            }
        ];

        #initialized = false;
        #iconMap = new Map();

        constructor() {
            this.#initializeStaticIcons();
        }

        /**
         * Initializes static icons
         */
        #initializeStaticIcons() {
            Object.entries(IconUtils.SVG).forEach(([key, value]) => {
                this.#iconMap.set(key, value);
            });
        }

        /**
         * Initialize Vivaldi icons from the DOM or use fallback
         */
        #initializeVivaldiIcons() {
            if (this.#initialized) return;

            IconUtils.VIVALDI_BUTTONS.forEach(button => {
                this.#iconMap.set(button.name, this.#getVivaldiButton(button.buttonName, button.fallback));
            });

            this.#initialized = true;
        }

        /**
         * Gets the SVG of a Vivaldi button or returns the fallback
         * @param {string} buttonName - name of the button in Vivali ui
         * @param {string} fallbackSVG - fallback svg if no icon is found
         * @returns {string} - the SVG as a string
         */
        #getVivaldiButton(buttonName, fallbackSVG) {
            const svg = document.querySelector(`.button-toolbar [data-name="${buttonName}"] svg`);
            return svg ? svg.cloneNode(true).outerHTML : fallbackSVG;
        }

        /**
         * Get icon by name
         * @param {string} name - Name of the icon
         * @returns {string} - Icon as SVG string
         */
        getIcon(name) {
            if (!this.#initialized && IconUtils.VIVALDI_BUTTONS.some(btn => btn.name === name)) {
                this.#initializeVivaldiIcons();
            }

            return this.#iconMap.get(name) || '';
        }

        get ellipsis() {
            return this.getIcon('ellipsis');
        }

        get back() {
            return this.getIcon('back');
        }

        get forward() {
            return this.getIcon('forward');
        }

        get reload() {
            return this.getIcon('reload');
        }

        get readerView() {
            return this.getIcon('readerView');
        }

        get settings() {
            return this.getIcon('settings');
        }

        get newTab() {
            return this.getIcon('newTab');
        }

        get backgroundTab() {
            return this.getIcon('backgroundTab');
        }
    }
})();
