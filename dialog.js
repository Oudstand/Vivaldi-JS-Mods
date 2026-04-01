/**
 * Opens links in a dialog, either by key combinations, holding the middle mouse button or context menu
 * Forum link: https://forum.vivaldi.net/topic/92501/open-in-dialog-mod?_=1717490394230
 */
(() => {
    const ICON_CONFIG = {
            linkIcon: '', // if set, an icon shows up after links - example values 'fa-solid fa-up-right-from-square', 'fa-solid fa-circle-info', 'fa-regular fa-square' search for other icons: https://fontawesome.com/search?o=r&ic=free&s=solid&ip=classic
            linkIconInteractionOnHover: true, // if false, you have to click the icon to show the dialog - if true, the dialog shows on mouseenter
            showIconDelay: 250, // set to 0 to disable - delays showing the icon on hovering a link
            showDialogOnHoverDelay: 250 // set to 0 to disable - delays showing the dialog on hovering the linkIcon
        },
        CONTEXT_MENU_CONFIG = {
            menuPrefix: '[Dialog Tab]',
            linkMenuTitle: 'Link öffnen',
            searchMenuTitle: 'Suche nach "%s"',
            selectSearchMenuTitle: 'Suche mit'
        };

    // Wait for the browser to come to a ready state
    setTimeout(function waitDialog() {
        const browser = document.getElementById('browser');
        if (!browser) {
            return setTimeout(waitDialog, 300);
        }
        new DialogMod();
    }, 300);

    class DialogMod {
        // Animation constants
        ANIMATION_DURATIONS = {
            CLOSE_TIMEOUT: 800, // Fallback timeout for close animation
            FADE_DELAY: 90, // Delay before starting fade animation
            PROGRESS_CLEAR: 250, // Progress bar clear timeout
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
                    const tabId = Number(document.querySelector('.active.visible.webpageview webview').tab_id);
                    webviewData = webviewValues.findLast(_data => _data.tabId === tabId);
                }
                webviewData && this.removeDialog(webviewData.webview.id);
            }
        };
        // 'https://clearthis.page/?u='; stopped service?
        // change also in dialog.css => &:has(webview[src^="READER_VIEW_URL"]) .reader-view-toggle
        // alternative => https://www.smry.ai/proxy?url=
        READER_VIEW_URL = 'https://app.web-highlights.com/reader/open-website-in-reader-mode?url=';

        constructor() {
            // Setup keyboard shortcuts
            vivaldi.tabsPrivate.onKeyboardShortcut.addListener(this.keyCombo.bind(this));

            new WebsiteInjectionUtils(
                navigationDetails => this.getWebviewConfig(navigationDetails),
                (url, fromPanel, origin) => this.dialogTab(url, fromPanel, origin), // pass origin through
                ICON_CONFIG
            );
        }

        /**
         * Finds the correct configuration for showing the dialog
         */
        getWebviewConfig(navigationDetails) {
            if (navigationDetails.frameType !== 'outermost_frame') return {webview: null, fromPanel: false};

            // first dialog from tab or webpanel
            let webview = document.querySelector(`webview[tab_id="${navigationDetails.tabId}"]`);
            if (webview) return {webview, fromPanel: webview.name === 'vivaldi-webpanel'};

            // follow-up dialog from the webpanel
            webview = Array.from(this.webviews.values()).find(view => view.fromPanel)?.webview;
            if (webview) return {webview, fromPanel: true};

            // follow-up dialog from tab
            const lastWebviewId = document.querySelector('.active.visible.webpageview .dialog-container:last-of-type webview')?.id;
            return {webview: this.webviews.get(lastWebviewId)?.webview, fromPanel: false};
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

        /**
         * Removes the dialog for a given webview
         * @param webviewId The id of the webview
         */
        removeDialog(webviewId) {
            const data = this.webviews.get(webviewId);
            if (!data) return;

            const container = data.divContainer;
            const dialogTab = container.querySelector('.dialog-tab');

            if (container.dataset.closing === '1') return;
            container.dataset.closing = '1';

            const pointerX = Number(container.dataset.pointerX ?? window.innerWidth / 2);
            const pointerY = Number(container.dataset.pointerY ?? window.innerHeight / 2);

            // Recompute anchored translate for current layout
            this.setAnchoredTransformVars(dialogTab, pointerX, pointerY);

            requestAnimationFrame(() => {
                container.classList.remove('is-open'); // overlay fades out via transition
                container.classList.add('is-leave'); // optional: block clicks
                // remove blur immediately so background is crisp while closing
                container.style.backdropFilter = 'none';

                dialogTab.classList.add('animating-close');

                const finishRemoval = () => {
                    chrome.tabs.query({}, tabs => {
                        const tab = tabs.find(tab => tab.vivExtData && tab.vivExtData.includes(`${webviewId}tabId`));
                        if (tab) chrome.tabs.remove(tab.id);
                    });

                    container.classList.remove('is-leave');
                    data.divContainer.remove();

                    // Clean up event listeners
                    if (data.tabCloseListener) {
                        chrome.tabs.onRemoved.removeListener(data.tabCloseListener);
                    }
                    if (data.pointerdownListener && data.fromPanel) {
                        document.body.removeEventListener('pointerdown', data.pointerdownListener);
                    }

                    this.webviews.delete(webviewId);
                };

                const onCloseEnd = e => {
                    if (e.animationName === 'dialog-tab-close-anchored') {
                        dialogTab.removeEventListener('animationend', onCloseEnd);
                        finishRemoval();
                    }
                };
                dialogTab.addEventListener('animationend', onCloseEnd);

                // Fallback in case animationend doesn't fire
                setTimeout(finishRemoval, this.ANIMATION_DURATIONS.CLOSE_TIMEOUT);
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
                optionsContainer = document.createElement('div');

            if (fromPanel === undefined && this.webviews.size !== 0) {
                fromPanel = Array.from(this.webviews.values()).at(-1).fromPanel;
            }

            const tabId = !fromPanel ? Number(document.querySelector('.active.visible.webpageview webview').tab_id) : null;

            this.webviews.set(webviewId, {
                divContainer: dialogContainer,
                webview: webview,
                fromPanel: fromPanel,
                tabId: tabId,
                pointerdownListener: null // Will be set later if fromPanel is true
            });

            // remove dialogs when tab is closed without closing dialogs
            if (!fromPanel) {
                const clearWebviews = closedTabId => {
                    if (tabId === closedTabId) {
                        this.webviews.forEach((view, key) => view.tabCloseListener === clearWebviews && this.removeDialog(key));
                        chrome.tabs.onRemoved.removeListener(clearWebviews);
                    }
                };
                this.webviews.get(webviewId).tabCloseListener = clearWebviews;
                chrome.tabs.onRemoved.addListener(clearWebviews);
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
            optionsContainer.innerHTML = this.iconUtils.ellipsis;

            let timeout;
            optionsContainer.addEventListener('mouseover', () => {
                if (optionsContainer.children.length === 1) {
                    optionsContainer.innerHTML = '';
                    this.showWebviewOptions(webviewId, optionsContainer);
                }
                clearTimeout(timeout);
            });
            optionsContainer.addEventListener('mouseleave', () => {
                timeout = setTimeout(() => (optionsContainer.innerHTML = this.iconUtils.ellipsis), this.ANIMATION_DURATIONS.OPTIONS_HIDE);
            });
            //#endregion

            //#region webview properties
            webview.id = webviewId;
            webview.tab_id = `${webviewId}tabId`;
            webview.setAttribute('src', linkUrl);

            webview.addEventListener('loadstart', () => {
                webview.style.backgroundColor = 'var(--colorBorder)';
                progressBar.start();

                const input = document.getElementById(`input-${webview.id}`);
                if (input !== null) {
                    input.value = webview.src;
                }
            });
            webview.addEventListener('loadstop', () => progressBar.clear(true));
            fromPanel && webview.addEventListener('mousedown', event => event.stopPropagation());
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
                document.body.addEventListener('pointerdown', stopEvent);
                // Store listener reference for cleanup
                this.webviews.get(webviewId).pointerdownListener = stopEvent;
            }

            dialogContainer.addEventListener('click', event => {
                if (event.target === dialogContainer) {
                    this.removeDialog(webviewId);
                }
            });

            //#endregion

            dialogTab.appendChild(optionsContainer);
            dialogTab.appendChild(progressBar.element);
            dialogTab.appendChild(webview);

            dialogContainer.appendChild(dialogTab);

            (fromPanel ? document.querySelector('#browser') : document.querySelector('.active.visible.webpageview')).appendChild(dialogContainer);

            // Two-frame start: measure anchored start, then overlay, then animate with a tiny delay
            requestAnimationFrame(() => {
                const t = this.setAnchoredTransformVars(dialogTab, pointerX, pointerY); // sets --tx0/--ty0/--s0 and returns numbers
                // show anchored start inline immediately
                dialogTab.style.transform = `translate(${t.t0x}px, ${t.t0y}px) scale(${t.s0})`;
                dialogTab.style.opacity = '0';
                dialogTab.style.visibility = 'visible';
                dialogTab.getBoundingClientRect();

                requestAnimationFrame(() => {
                    dialogContainer.classList.add('is-open');
                    setTimeout(() => {
                        dialogTab.classList.add('animating-open');

                        const onOpenEnd = e => {
                            if (e.animationName === 'dialog-tab-open-anchored') {
                                dialogTab.classList.remove('animating-open');
                                // cleanup inline styles
                                dialogTab.style.removeProperty('transform');
                                dialogTab.style.removeProperty('opacity');
                                dialogTab.removeEventListener('animationend', onOpenEnd);
                            }
                        };
                        dialogTab.addEventListener('animationend', onOpenEnd);
                    }, this.ANIMATION_DURATIONS.FADE_DELAY);
                });
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

        /**
         * Displays open in tab buttons and current url in input element
         * @param {string} webviewId is the id of the webview
         * @param {Object} thisElement the current instance divOptionContainer (div) element
         */
        showWebviewOptions(webviewId, thisElement) {
            let inputId = `input-${webviewId}`,
                data = this.webviews.get(webviewId),
                webview = data ? data.webview : undefined;
            if (webview && document.getElementById(inputId) === null) {
                const input = document.createElement('input', 'text'),
                    // Allowed URL schemes for webview navigation
                    VALID_URL_PREFIXES = ['http://', 'https://', 'file://', 'vivaldi://', 'chrome://', 'chrome-extension://', 'data:', 'blob:'],
                    // Blocked schemes that could be dangerous
                    BLOCKED_SCHEMES = ['javascript:', 'vbscript:'],
                    isValidUrl = url => {
                        if (!url || typeof url !== 'string') return false;
                        const trimmedUrl = url.trim();

                        // Check for blocked schemes first
                        if (BLOCKED_SCHEMES.some(scheme => trimmedUrl.toLowerCase().startsWith(scheme))) {
                            return false;
                        }

                        // Allow about: pages
                        if (trimmedUrl.startsWith('about:')) return true;

                        // Check valid prefixes
                        return VALID_URL_PREFIXES.some(prefix => trimmedUrl.startsWith(prefix));
                    };

                input.value = webview.src;
                input.id = inputId;
                input.setAttribute('class', 'dialog-input');

                input.addEventListener('keydown', async event => {
                    if (event.key === 'Enter') {
                        let value = input.value;
                        if (isValidUrl(value)) {
                            webview.src = value;
                        } else {
                            const searchRequest = await vivaldi.searchEngines.getSearchRequest(this.searchEngineUtils.defaultSearchId, value);
                            webview.src = searchRequest.url;
                        }
                    }
                });

                const fragment = document.createDocumentFragment(),
                    buttons = [
                        {content: this.iconUtils.back, action: () => webview.back()},
                        {content: this.iconUtils.forward, action: () => webview.forward()},
                        {content: this.iconUtils.reload, action: () => webview.reload()},
                        {
                            content: this.iconUtils.readerView,
                            action: this.showReaderView.bind(this, webview),
                            cls: 'reader-view-toggle'
                        },
                        {content: this.iconUtils.newTab, action: this.openNewTab.bind(this, inputId, true)},
                        {content: this.iconUtils.backgroundTab, action: this.openNewTab.bind(this, inputId, false)}
                    ];

                buttons.forEach(button => fragment.appendChild(this.createOptionsButton(button.content, button.action, button.cls || '')));
                fragment.appendChild(input);

                thisElement.append(fragment);
            }
        }

        /**
         * Create a button with default style for the web view options.
         * @param {Node | string} content the content of the button to display
         * @param {Function} clickListenerCallback the click listeners callback function
         * @param {string} cls optional additional class for the button
         */
        createOptionsButton(content, clickListenerCallback, cls = '') {
            const button = document.createElement('button');
            button.setAttribute('class', `options-button ${cls}`.trim());
            button.addEventListener('click', clickListenerCallback);

            if (typeof content === 'string') {
                button.innerHTML = content;
            } else {
                button.appendChild(content);
            }

            return button;
        }

        /**
         * Returns a unique, collision-resistant id.
         * Uses timestamp + random alphanumeric string for uniqueness.
         */
        getWebviewId() {
            const timestamp = Date.now();
            const randomPart = Math.random().toString(36).substring(2, 11);
            return `${timestamp}-${randomPart}`;
        }

        /**
         * Sets the webviews content to a reader version
         *
         * @param {webview} webview the webview to update
         */
        showReaderView(webview) {
            const dialogTab = webview.parentElement;
            if (webview.src.includes(this.READER_VIEW_URL)) {
                webview.src = webview.src.replace(this.READER_VIEW_URL, '');
                dialogTab.classList.remove('reader-open');
            } else {
                webview.src = this.READER_VIEW_URL + webview.src;
                dialogTab.classList.add('reader-open');
            }
        }

        /**
         * Opens a new Chrome tab with specified active boolean value
         * @param {string} inputId is the id of the input containing current url
         * @param {boolean} active indicates whether the tab is active or not (background tab)
         */
        openNewTab(inputId, active) {
            const url = document.getElementById(inputId).value;
            chrome.tabs.create({url: url, active: active});
        }
    }

    class WebsiteInjectionUtils {
        constructor(getWebviewConfig, openDialog, iconConfig) {
            this.iconConfig = JSON.stringify(iconConfig);

            // inject detection of click observers
            chrome.webNavigation.onCompleted.addListener(navigationDetails => {
                const {webview, fromPanel} = getWebviewConfig(navigationDetails);
                webview && this.injectCode(webview, fromPanel);
            });

            // react on demand to open a dialog
            chrome.runtime.onMessage.addListener(message => {
                if (message.url) {
                    openDialog(message.url, message.fromPanel, message.origin);
                }
            });
        }

        injectCode(webview, fromPanel) {
            const handler = WebsiteLinkInteractionHandler.toString(),
                instantiationCode = `
                if (!this.dialogEventListenerSet) {
                    new (${handler})(${fromPanel}, ${this.iconConfig});
                    this.dialogEventListenerSet = true;
                }
            `;

            try {
                webview.executeScript({code: instantiationCode}, result => {
                    if (chrome.runtime.lastError) {
                        // Script injection failed (e.g., on chrome:// pages or blocked by CSP)
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
            this.icon = null;
            this.timers = {showIcon: null, showDialog: null, hideIcon: null};

            this.#initialize();
        }

        /**
         * Checks if a link is clicked by the middle mouse while pressing Ctrl + Alt, then fires an event with the Url
         */
        #initialize() {
            this.#setupMouseHandling();

            if (this.config.linkIcon) {
                this.#setupIconHandling();
            }
        }

        /**
         * Richtet die Maus-Event-Listener ein
         */
        #setupMouseHandling() {
            let holdTimerForMiddleClick;

            document.addEventListener('pointerdown', event => {
                // Check if the Ctrl key, Alt key, and mouse button were pressed
                if (event.ctrlKey && event.altKey && [0, 1].includes(event.button)) {
                    this.#callDialog(event);
                } else if (event.button === 1) {
                    // MMB-hold: cache link+coords NOW, use after timeout (prevents drift)
                    const link = this.#getLinkElement(event);
                    if (!link) return;
                    const px = event.clientX,
                        py = event.clientY;
                    const href = link.href;
                    holdTimerForMiddleClick = setTimeout(() => {
                        this.#sendDialogMessage(href, px, py);
                    }, 500);
                }
            });

            document.addEventListener('pointerup', event => {
                if (event.button === 1) clearTimeout(holdTimerForMiddleClick);
            });
        }

        #setupIconHandling() {
            this.#createIcon();
            this.#createIconStyle();

            document.addEventListener(
                'mouseover',
                this.debounce(event => {
                    const link = this.#getLinkElement(event);
                    if (!link) return;

                    clearTimeout(this.timers.hideIcon);

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

                    link.addEventListener('mouseleave', this.#hideLinkIcon.bind(this));
                }, this.config.showIconDelay)
            );
        }

        #createIcon() {
            const icon = document.createElement('div');
            icon.className = `link-icon ${this.config.linkIcon}`;
            icon.style.display = 'none';

            const getLinkCenter = () => {
                const el = this.currentLinkEl;
                if (el) {
                    const r = el.getBoundingClientRect();
                    return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)};
                }
                return {x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2)};
            };

            if (this.config.linkIconInteractionOnHover) {
                icon.addEventListener('mouseenter', () => {
                    this.timers.showDialog = setTimeout(() => {
                        const {x, y} = getLinkCenter();
                        this.#sendDialogMessage(this.icon.dataset.targetUrl, x, y);
                    }, this.config.showDialogOnHoverDelay);
                });
                icon.addEventListener('mouseleave', () => clearTimeout(this.timers.showDialog));
            } else {
                icon.addEventListener('click', () => {
                    const {x, y} = getLinkCenter();
                    this.#sendDialogMessage(this.icon.dataset.targetUrl, x, y);
                });
                icon.addEventListener('mouseenter', () => clearTimeout(this.timers.hideIcon));
                icon.addEventListener('mouseleave', this.#hideLinkIcon.bind(this));
            }

            this.icon = icon;
            document.body.appendChild(this.icon);
        }

        #hideLinkIcon() {
            this.timers.hideIcon = setTimeout(
                () => {
                    this.icon.style.display = 'none';
                    clearTimeout(this.timers.showIcon);
                },
                this.config.linkIconInteractionOnHover ? 300 : 600
            );
        }

        #getLinkElement(event) {
            return event.target.closest('a[href]:not([href="#"])');
        }

        #sendDialogMessage(url, x, y) {
            chrome.runtime.sendMessage({url, fromPanel: this.fromPanel, origin: {x, y}});
        }

        #callDialog(event) {
            let link = this.#getLinkElement(event);
            if (link) {
                event.preventDefault();
                this.#sendDialogMessage(link.href, event.clientX, event.clientY);
            }
        }

        #createIconStyle() {
            const style = document.createElement('style');
            style.textContent = `
                .link-icon {
                    position: absolute;
                    box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);
                    cursor: pointer;
                    z-index: 9999;
                    transition: opacity 0.2s ease;
                }

                .link-icon:hover {
                    opacity: 0.9;
                }
            `;
            document.head.appendChild(style);
        }

        debounce(fn, delay) {
            let timer = null;
            return (...args) => {
                clearTimeout(timer);
                timer = setTimeout(fn.bind(this, ...args), delay);
            };
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
                title: `${this.menuPrefix} ${this.linkMenuTitle}`,
                contexts: ['link']
            });
            chrome.contextMenus.create({
                id: this.SEARCH_ID,
                title: `${this.menuPrefix} ${this.searchMenuTitle}`,
                contexts: ['selection']
            });
            chrome.contextMenus.create({
                id: this.SELECT_SEARCH_ID,
                title: `${this.menuPrefix} ${this.selectSearchMenuTitle}`,
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

    class ProgressBar {
        static CLEAR_DELAY = 250; // Delay before hiding progress bar after completion

        constructor(webviewId) {
            this.webviewId = webviewId;
            this.progress = 0;
            this.interval = null;
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

            if (!this.interval) {
                this.interval = setInterval(() => {
                    if (this.progress >= 100) {
                        this.clear();
                    } else {
                        this.progress++;
                        this.element.style.width = this.progress + '%';
                    }
                }, 10);
            }
        }

        clear(loadStop = false) {
            this.element.classList.add('is-complete');

            if (this.interval) {
                clearInterval(this.interval);
                this.interval = null;
            }

            if (loadStop) {
                this.element.style.width = '100%';

                setTimeout(() => {
                    this.progress = 0;
                    this.element.style.visibility = 'hidden';
                    this.element.style.width = this.progress + '%';
                }, ProgressBar.CLEAR_DELAY);
            }
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

        get newTab() {
            return this.getIcon('newTab');
        }

        get backgroundTab() {
            return this.getIcon('backgroundTab');
        }
    }
})();
