/*
 * Safari compact address bar
 *
 * Projects the real address field over the clicked tab and restores the
 * regular tab layout when the user clicks somewhere else.
 * Requires the address field to be placed in the tab bar via the toolbar editor.
 */
(function safari_compact_addressbar() {
    'use strict';

    const ENABLED = true;
    // Keeps the projected address field visible on the active tab after focus leaves it.
    const KEEP_ADDRESS_FIELD_OPEN = true;
    // Opens the projected address field automatically after switching to another tab.
    const OPEN_ADDRESS_FIELD_ON_TAB_SWITCH = true;
    const DISABLED_URLS = ['vivaldi:mail'];

    const ROOT_CLASS = 'safari-compact-addressbar';
    const OPEN_CLASS = 'safari-compact-addressbar-open';
    const CLOSING_CLASS = 'safari-compact-addressbar-closing';
    const FIELD_CLASS = 'safari-compact-addressbar-field';
    const TAB_CLASS = 'safari-compact-addressbar-tab';
    const TAB_POSITION_CLASS = 'safari-compact-addressbar-tab-position';

    const OVERRIDE_VIVALDI_ACTIVE_TAB_MIN_WIDTH = true;
    const VIVALDI_ACTIVE_TAB_MIN_WIDTH_PREF = 'vivaldi.tabs.active_min_size';
    const ACTIVE_TAB_MIN_WIDTH = 360;
    const CLOSE_TRANSITION_MS = 220;
    const TAB_LAYOUT_SETTLE_MS = 120;

    let addressField = null;
    let addressFieldHome = null;
    let observer = null;
    let resizeObserver = null;
    let resizeObservedElements = new WeakSet();
    let initialLayoutReady = false;
    let layoutResizePending = false;
    let layoutSnapshot = null;
    let closeTransitionTimer = null;
    let settledLayoutTimer = null;
    let scheduled = false;

    function getBrowser() {
        return document.querySelector('#browser');
    }

    function getAddressField() {
        return addressField && document.contains(addressField)
            ? addressField
            : document.querySelector('#tabs-container .UrlBar-AddressField, .UrlBar-AddressField');
    }

    function getActiveTab() {
        return document.querySelector('#tabs-tabbar-container .tab-position .tab.active');
    }

    function getTabPosition(tab) {
        return tab?.closest('#tabs-tabbar-container .tab-position');
    }

    function getTabFromEvent(event) {
        const tab = event.target.closest('#tabs-tabbar-container .tab-position .tab');
        if (!tab || event.target.closest('.close')) return null;
        return tab;
    }

    function getClosingTabFromEvent(event) {
        return event.target
            .closest('#tabs-tabbar-container .tab-position .tab .close')
            ?.closest('#tabs-tabbar-container .tab-position .tab');
    }

    function isHorizontalTabBar(browser) {
        return browser.classList.contains('tabs-top') || browser.classList.contains('tabs-bottom');
    }

    function schedule(callback) {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            callback();
        });
    }

    function scheduleSettledRefresh() {
        window.clearTimeout(settledLayoutTimer);
        settledLayoutTimer = window.setTimeout(() => {
            layoutResizePending = true;
            refresh();
        }, TAB_LAYOUT_SETTLE_MS);
    }

    function scheduleLayoutSettle() {
        layoutResizePending = true;
        clearExpandedTabLayout();
        scheduleSettledRefresh();
    }

    async function syncActiveTabMinWidthPreference() {
        if (!OVERRIDE_VIVALDI_ACTIVE_TAB_MIN_WIDTH || !globalThis.vivaldi?.prefs) return;

        try {
            const rawValue = await vivaldi.prefs.get(VIVALDI_ACTIVE_TAB_MIN_WIDTH_PREF);
            const currentValue = typeof rawValue === 'object' && rawValue !== null && 'value' in rawValue
                ? rawValue.value
                : rawValue;
            if (typeof currentValue === 'number' && currentValue >= ACTIVE_TAB_MIN_WIDTH) return;

            await vivaldi.prefs.set({
                path: VIVALDI_ACTIVE_TAB_MIN_WIDTH_PREF,
                value: ACTIVE_TAB_MIN_WIDTH
            });
            scheduleLayoutSettle();
        } catch (_) {
            // Some Vivaldi builds expose prefs late; the mod still works with the current tab width.
        }
    }

    function focusUrlInput(field) {
        const input = field.querySelector('#urlFieldInput, input');
        if (!input) return;
        input.focus();
        input.select?.();
    }

    function rememberAddressFieldHome(field) {
        if (addressFieldHome || !field.parentNode) return;

        const marker = document.createComment('safari compact address bar field home');
        field.parentNode.insertBefore(marker, field);
        addressFieldHome = {marker};
    }

    function restoreAddressFieldHome(field) {
        const marker = addressFieldHome?.marker;
        if (!marker?.parentNode || field.parentNode === marker.parentNode) return;

        marker.parentNode.insertBefore(field, marker.nextSibling);
    }

    function moveAddressFieldIntoTab(tab, field) {
        rememberAddressFieldHome(field);
        if (field.parentNode !== tab) {
            tab.appendChild(field);
        }
    }

    function getAddressFieldValue(field) {
        const input = field.querySelector('#urlFieldInput, input');
        const value = input?.value || field.querySelector('.UrlFragment-Link, .UrlBar-UrlField')?.textContent || '';
        return value.trim().toLowerCase();
    }

    function isDisabledUrl(field) {
        const value = getAddressFieldValue(field);
        const disabledByUrl = DISABLED_URLS.some(disabledUrl => value === disabledUrl || value.startsWith(`${disabledUrl}/`));
        return disabledByUrl || Boolean(document.querySelector('.toolbar-mailbar.toolbar-visible'));
    }

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function readCssPixelValue(element, property, fallback) {
        const parsed = parseFloat(getComputedStyle(element).getPropertyValue(property));
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function readTranslateX(element) {
        const transform = getComputedStyle(element).transform;
        if (!transform || transform === 'none') return null;

        try {
            return new DOMMatrixReadOnly(transform).m41;
        } catch (_) {
            const matrix = transform.match(/^matrix(3d)?\((.+)\)$/);
            if (!matrix) return null;

            const values = matrix[2].split(',').map(value => parseFloat(value.trim()));
            const translateX = matrix[1] ? values[12] : values[4];
            return Number.isFinite(translateX) ? translateX : null;
        }
    }

    function getTabPositionsInStrip(tab) {
        const tabStrip = tab.closest('.tab-strip');
        if (!tabStrip) return [];

        return [...tabStrip.querySelectorAll('.tab-position')]
            .filter(tabPosition => !tabPosition.classList.contains('accordion-toggle-arrow'))
            .filter(tabPosition => tabPosition.querySelector('.tab'));
    }

    function restoreStyleProperty(element, property, value) {
        if (value) {
            element.style.setProperty(property, value);
        } else {
            element.style.removeProperty(property);
        }
    }

    function isTabStateStillApplied(tabState) {
        return (
            tabState.appliedInlineWidth === undefined ||
            tabState.element.style.getPropertyValue('--Width') === tabState.appliedInlineWidth
        ) && (
            tabState.appliedInlinePositionX === undefined ||
            tabState.element.style.getPropertyValue('--PositionX') === tabState.appliedInlinePositionX
        );
    }

    function clearExpandedTabLayout() {
        document.querySelectorAll(`.${TAB_CLASS}`).forEach(tab => {
            tab.classList.remove(TAB_CLASS);
        });

        if (layoutSnapshot) {
            layoutSnapshot.tabs.forEach(tabState => {
                tabState.element.classList.remove(TAB_POSITION_CLASS);
                if (isTabStateStillApplied(tabState)) {
                    restoreStyleProperty(tabState.element, '--Width', tabState.originalInlineWidth);
                    restoreStyleProperty(tabState.element, '--PositionX', tabState.originalInlinePositionX);
                }
            });
            layoutSnapshot = null;
        } else {
            document.querySelectorAll(`.${TAB_POSITION_CLASS}`).forEach(tabPosition => {
                tabPosition.classList.remove(TAB_POSITION_CLASS);
            });
        }
    }

    function captureTabLayout(tab) {
        const tabPositions = getTabPositionsInStrip(tab)
            .map(tabPosition => {
                const rect = tabPosition.getBoundingClientRect();
                const positionX = readCssPixelValue(tabPosition, '--PositionX', rect.left);
                const translateX = readTranslateX(tabPosition);
                return {
                    element: tabPosition,
                    tab: tabPosition.querySelector('.tab'),
                    width: readCssPixelValue(tabPosition, '--Width', rect.width),
                    positionX,
                    originLeft: rect.left - (translateX ?? positionX),
                    viewportLeft: rect.left,
                    viewportTop: rect.top,
                    height: rect.height,
                    originalInlineWidth: tabPosition.style.getPropertyValue('--Width'),
                    originalInlinePositionX: tabPosition.style.getPropertyValue('--PositionX')
                };
            })
            .sort((first, second) => first.positionX - second.positionX);

        const tabStrip = tab.closest('.tab-strip');
        const stripWidth = tabStrip?.getBoundingClientRect().width ||
            tabPositions.reduce((width, tabState) => Math.max(width, tabState.positionX + tabState.width), 0);

        return {tabPositions, stripWidth};
    }

    function hasExternalTabLayoutChange() {
        if (!layoutSnapshot) return false;
        return layoutSnapshot.tabs.some(tabState => !isTabStateStillApplied(tabState));
    }

    function isExternalTabStyleMutation(mutation) {
        if (mutation.attributeName !== 'style') return false;
        if (!mutation.target.classList?.contains('tab-position')) return false;
        if (!layoutSnapshot) return true;

        const tabState = layoutSnapshot.tabs.find(state => state.element === mutation.target);
        return !tabState || !isTabStateStillApplied(tabState);
    }

    function isAddressFieldMoveNode(node) {
        return node === addressField ||
            node.classList?.contains(FIELD_CLASS) ||
            node.querySelector?.(`.${FIELD_CLASS}`);
    }

    function isTabStructureMutation(mutation) {
        if (mutation.type !== 'childList') return false;

        return [...mutation.addedNodes, ...mutation.removedNodes].some(node => (
            node.nodeType === Node.ELEMENT_NODE &&
            !isAddressFieldMoveNode(node) &&
            (
                node.classList?.contains('tab-position') ||
                node.querySelector?.('.tab-position') ||
                node.closest?.('#tabs-tabbar-container .tab-strip')
            )
        ));
    }

    function isRelevantClassMutation(mutation) {
        if (mutation.attributeName !== 'class') return false;
        return Boolean(mutation.target.closest?.('#tabs-container'));
    }

    function isToolbarLayoutMutation(mutation) {
        if (mutation.attributeName !== 'class') return false;

        return Boolean(
            mutation.target.closest?.('#tabs-container > .toolbar-tabbar-before') ||
            mutation.target.closest?.('#tabs-container > .toolbar-tabbar-after') ||
            mutation.target.closest?.('.toolbar-mailbar')
        );
    }

    function isLayoutSnapshotCurrent(tab, activeTabPosition) {
        if (!layoutSnapshot || layoutSnapshot.activeTabPosition !== activeTabPosition) return false;
        if (hasExternalTabLayoutChange()) return false;

        const tabPositions = getTabPositionsInStrip(tab);
        if (tabPositions.length !== layoutSnapshot.tabs.length) return false;

        const tabPositionSet = new Set(tabPositions);
        if (!layoutSnapshot.tabs.every(tabState => tabPositionSet.has(tabState.element))) return false;

        const tabStrip = tab.closest('.tab-strip');
        const stripWidth = tabStrip?.getBoundingClientRect().width || layoutSnapshot.stripWidth;
        return Math.abs(stripWidth - layoutSnapshot.stripWidth) < 1;
    }

    function updateExpandedPinnedTabLayout(tab, activeTabPosition) {
        if (!layoutSnapshot || !layoutSnapshot.tabs.some(tabState => tabState.element === activeTabPosition)) {
            const {tabPositions, stripWidth} = captureTabLayout(tab);
            layoutSnapshot = {
                activeTabPosition,
                stripWidth,
                tabs: tabPositions
            };
        }

        const activeTabState = layoutSnapshot.tabs.find(tabState => tabState.element === activeTabPosition);
        if (!activeTabState) return null;

        const targetActiveWidth = Math.max(activeTabState.width, ACTIVE_TAB_MIN_WIDTH);
        const positionShift = targetActiveWidth - activeTabState.width;
        let activeGeometry = null;

        layoutSnapshot.tabs.forEach(tabState => {
            const isActiveTab = tabState === activeTabState;
            const width = isActiveTab ? targetActiveWidth : tabState.width;
            const positionX = tabState.positionX > activeTabState.positionX
                ? tabState.positionX + positionShift
                : tabState.positionX;
            const widthValue = `${width}px`;
            const positionValue = `${positionX}px`;

            tabState.element.classList.toggle(TAB_POSITION_CLASS, isActiveTab);
            tabState.element.style.setProperty('--Width', widthValue);
            tabState.element.style.setProperty('--PositionX', positionValue);
            tabState.appliedInlineWidth = widthValue;
            tabState.appliedInlinePositionX = positionValue;

            if (isActiveTab) {
                activeGeometry = {
                    left: tabState.originLeft + positionX,
                    top: tabState.viewportTop,
                    width,
                    height: tabState.height
                };
            }
        });

        return activeGeometry;
    }

    function updateExpandedTabLayout(tab) {
        const activeTabPosition = getTabPosition(tab);
        if (!activeTabPosition) return;

        if (tab.classList.contains('pinned')) {
            return updateExpandedPinnedTabLayout(tab, activeTabPosition);
        }

        document.querySelectorAll(`.${TAB_POSITION_CLASS}`).forEach(tabPosition => {
            tabPosition.classList.toggle(TAB_POSITION_CLASS, tabPosition === activeTabPosition);
        });

        const rect = activeTabPosition.getBoundingClientRect();
        return {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height
        };
    }

    function refreshExpandedTabLayout(tab, field) {
        const activeTabPosition = getTabPosition(tab);
        if (!activeTabPosition) return null;

        if (layoutSnapshot && (layoutResizePending || !isLayoutSnapshotCurrent(tab, activeTabPosition))) {
            clearExpandedTabLayout();
            tab.classList.add(TAB_CLASS);
            updateProjectedAddressField(tab, field);
            void field.offsetWidth;
        }
        layoutResizePending = false;

        return updateExpandedTabLayout(tab);
    }

    function observeResizeTarget(element) {
        if (!resizeObserver || !element || resizeObservedElements.has(element)) return;

        resizeObservedElements.add(element);
        resizeObserver.observe(element);
    }

    function observeLayoutResizeTargets() {
        observeResizeTarget(document.querySelector('#tabs-container'));
        observeResizeTarget(document.querySelector('#tabs-tabbar-container'));
    }

    function setProjectedAddressFieldGeometry(field, geometry) {
        if (!geometry) return;

        field.style.setProperty('--safariCompactFieldLeft', `${geometry.left}px`);
        field.style.setProperty('--safariCompactFieldTop', `${geometry.top}px`);
        field.style.setProperty('--safariCompactFieldWidth', `${geometry.width}px`);
        field.style.setProperty('--safariCompactFieldHeight', `${geometry.height}px`);
    }

    function updateProjectedAddressField(tab, field) {
        const tabPosition = getTabPosition(tab);
        const rect = (tabPosition || tab).getBoundingClientRect();

        setProjectedAddressFieldGeometry(field, {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height
        });
    }

    function getOriginalActiveTabGeometry() {
        const activeTabState = layoutSnapshot?.tabs.find(tabState => tabState.element === layoutSnapshot.activeTabPosition);
        if (!activeTabState) return null;

        return {
            left: activeTabState.originLeft + activeTabState.positionX,
            top: activeTabState.viewportTop,
            width: activeTabState.width,
            height: activeTabState.height
        };
    }

    function clearProjectedAddressField(field) {
        field.style.removeProperty('--safariCompactFieldLeft');
        field.style.removeProperty('--safariCompactFieldTop');
        field.style.removeProperty('--safariCompactFieldWidth');
        field.style.removeProperty('--safariCompactFieldHeight');
    }

    function resetAddressFieldProjection(field) {
        restoreAddressFieldHome(field);
        field.classList.remove(FIELD_CLASS);
        clearProjectedAddressField(field);
    }

    function closeAddressField({animate = true} = {}) {
        const browser = getBrowser();
        const field = getAddressField();
        if (!field) return;

        if (browser) {
            window.clearTimeout(closeTransitionTimer);
            browser.classList.toggle(CLOSING_CLASS, animate);
        }

        clearExpandedTabLayout();
        resetAddressFieldProjection(field);

        if (browser) {
            browser.classList.remove(OPEN_CLASS);
            closeTransitionTimer = window.setTimeout(() => {
                browser.classList.remove(CLOSING_CLASS);
            }, animate ? CLOSE_TRANSITION_MS : 0);
        } else {
            resetAddressFieldProjection(field);
        }
    }

    function openAddressField(tab, shouldFocus = true) {
        const browser = getBrowser();
        const field = getAddressField();

        if (!ENABLED || !browser || !field || !tab || !isHorizontalTabBar(browser)) return;
        if (browser.classList.contains('toolbar-edit-mode')) return;
        if (isDisabledUrl(field)) {
            closeAddressField();
            return;
        }

        window.clearTimeout(closeTransitionTimer);
        browser.classList.remove(CLOSING_CLASS);

        resetAddressFieldProjection(field);
        clearExpandedTabLayout();
        tab.classList.add(TAB_CLASS);
        moveAddressFieldIntoTab(tab, field);
        field.classList.add(FIELD_CLASS);
        browser.classList.add(ROOT_CLASS, OPEN_CLASS);
        void field.offsetWidth;
        setProjectedAddressFieldGeometry(field, refreshExpandedTabLayout(tab, field));

        if (shouldFocus) {
            setTimeout(() => focusUrlInput(field), 0);
        }
    }

    function handlePointerDown(event) {
        const browser = getBrowser();
        if (!browser?.classList.contains(ROOT_CLASS)) return;

        const field = getAddressField();
        const closingTab = getClosingTabFromEvent(event);
        if (field && closingTab?.classList.contains(TAB_CLASS)) {
            resetAddressFieldProjection(field);
            clearExpandedTabLayout();
            setTimeout(() => {
                const activeTab = getActiveTab();
                if (KEEP_ADDRESS_FIELD_OPEN && activeTab) {
                    openAddressField(activeTab, false);
                    return;
                }
                refresh();
            }, TAB_LAYOUT_SETTLE_MS);
            return;
        }

        if (field?.contains(event.target)) return;

        const clickedTab = getTabFromEvent(event);
        if (clickedTab) {
            if (!KEEP_ADDRESS_FIELD_OPEN && !OPEN_ADDRESS_FIELD_ON_TAB_SWITCH && !clickedTab.classList.contains('active')) {
                closeAddressField();
                return;
            }
            const shouldFocus = !KEEP_ADDRESS_FIELD_OPEN || clickedTab.classList.contains('active');
            setTimeout(() => openAddressField(getActiveTab() || clickedTab, shouldFocus), 80);
            return;
        }

        if (KEEP_ADDRESS_FIELD_OPEN) return;
        closeAddressField();
    }

    function handleKeyDown(event) {
        if (event.key === 'Escape') {
            closeAddressField();
        }
    }

    function handleFocusOut() {
        if (KEEP_ADDRESS_FIELD_OPEN) return;
        setTimeout(() => {
            const field = getAddressField();
            if (field?.contains(document.activeElement)) return;
            closeAddressField();
        }, 0);
    }

    function refresh() {
        const browser = getBrowser();
        const field = getAddressField();
        if (!browser || !field) return;

        observeLayoutResizeTargets();
        browser.classList.toggle(ROOT_CLASS, ENABLED && isHorizontalTabBar(browser));
        if (!initialLayoutReady) return;

        const activeTab = getActiveTab();
        if (!browser.classList.contains(ROOT_CLASS) || browser.classList.contains('toolbar-edit-mode') || isDisabledUrl(field)) {
            closeAddressField();
            return;
        }

        if (KEEP_ADDRESS_FIELD_OPEN && activeTab && !browser.classList.contains(OPEN_CLASS)) {
            openAddressField(activeTab, false);
            return;
        }

        const compactTab = document.querySelector(`.${TAB_CLASS}`);
        if (browser.classList.contains(OPEN_CLASS) && !compactTab) {
            if (KEEP_ADDRESS_FIELD_OPEN && activeTab) {
                openAddressField(activeTab, false);
                return;
            }
            closeAddressField();
            return;
        }

        if (browser.classList.contains(OPEN_CLASS) && compactTab && !compactTab.classList.contains('active')) {
            if (KEEP_ADDRESS_FIELD_OPEN && activeTab) {
                openAddressField(activeTab, false);
                return;
            }
            closeAddressField();
            return;
        }

        if (compactTab) {
            setProjectedAddressFieldGeometry(field, refreshExpandedTabLayout(compactTab, field));
        }
    }

    function init() {
        const browser = getBrowser();
        const field = getAddressField();
        const tabsContainer = document.querySelector('#tabs-container');

        if (!browser || !field || !tabsContainer) {
            setTimeout(init, 500);
            return;
        }

        addressField = field;
        browser.classList.add(ROOT_CLASS);
        syncActiveTabMinWidthPreference();

        document.addEventListener('pointerdown', handlePointerDown, true);
        document.addEventListener('keydown', handleKeyDown, true);
        window.addEventListener('resize', () => schedule(refresh), true);
        field.addEventListener('focusout', handleFocusOut, true);
        globalThis.vivaldi?.prefs?.onChanged?.addListener?.(event => {
            if (event?.path === VIVALDI_ACTIVE_TAB_MIN_WIDTH_PREF) scheduleLayoutSettle();
        });

        if ('ResizeObserver' in window) {
            resizeObserver = new ResizeObserver(() => {
                scheduleLayoutSettle();
            });
            observeLayoutResizeTargets();
        }

        observer = new MutationObserver(mutations => {
            const hasExternalTabStyleMutation = mutations.some(isExternalTabStyleMutation);
            const hasTabStructureMutation = mutations.some(isTabStructureMutation);
            const hasRelevantClassMutation = mutations.some(isRelevantClassMutation);
            const hasToolbarLayoutMutation = mutations.some(isToolbarLayoutMutation);
            const shouldRefresh = hasExternalTabStyleMutation || hasTabStructureMutation || hasRelevantClassMutation;
            if (!shouldRefresh) return;

            if (hasToolbarLayoutMutation) {
                scheduleLayoutSettle();
                if (!hasExternalTabStyleMutation && !hasTabStructureMutation) return;
            }

            if (hasExternalTabStyleMutation || hasTabStructureMutation) {
                layoutResizePending = true;
            }
            if (hasTabStructureMutation) {
                scheduleSettledRefresh();
                if (!hasExternalTabStyleMutation && !hasRelevantClassMutation) return;
            }
            schedule(refresh);
        });
        observer.observe(tabsContainer, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style'],
            attributeOldValue: true
        });

        window.setTimeout(() => {
            initialLayoutReady = true;
            layoutResizePending = true;
            refresh();
        }, 150);
    }

    setTimeout(init, 500);
})();
