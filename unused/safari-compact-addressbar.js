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

    const ACTIVE_TAB_WIDTH_RATIO = 0.34;
    const MAX_ACTIVE_TAB_WIDTH_RATIO = 0.42;
    const MIN_INACTIVE_TAB_WIDTH = 54;
    const CLOSE_TRANSITION_MS = 220;

    let addressField = null;
    let observer = null;
    let layoutSnapshot = null;
    let closeTransitionTimer = null;
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

    function focusUrlInput(field) {
        const input = field.querySelector('#urlFieldInput, input');
        if (!input) return;
        input.focus();
        input.select?.();
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

    function clearExpandedTabLayout({restore = true} = {}) {
        document.querySelectorAll(`.${TAB_CLASS}`).forEach(tab => {
            tab.classList.remove(TAB_CLASS);
        });

        if (layoutSnapshot) {
            const shouldRestoreSnapshot = restore && layoutSnapshot.tabs.every(isTabStateStillApplied);
            layoutSnapshot.tabs.forEach(tabState => {
                tabState.element.classList.remove(TAB_POSITION_CLASS);
                if (shouldRestoreSnapshot) {
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
                return {
                    element: tabPosition,
                    tab: tabPosition.querySelector('.tab'),
                    width: readCssPixelValue(tabPosition, '--Width', rect.width),
                    positionX: readCssPixelValue(tabPosition, '--PositionX', rect.left),
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

    function updateExpandedTabLayout(tab) {
        const activeTabPosition = getTabPosition(tab);
        if (!activeTabPosition) return;

        if (!layoutSnapshot || !layoutSnapshot.tabs.some(tabState => tabState.element === activeTabPosition)) {
            const {tabPositions, stripWidth} = captureTabLayout(tab);
            layoutSnapshot = {
                activeTabPosition,
                stripWidth,
                tabs: tabPositions
            };
        }

        const activeTabState = layoutSnapshot.tabs.find(tabState => tabState.element === activeTabPosition);
        if (!activeTabState) return;

        const maxActiveWidth = Math.max(activeTabState.width, layoutSnapshot.stripWidth * MAX_ACTIVE_TAB_WIDTH_RATIO);
        let targetActiveWidth = clamp(
            layoutSnapshot.stripWidth * ACTIVE_TAB_WIDTH_RATIO,
            activeTabState.width,
            maxActiveWidth
        );

        const requestedExtraWidth = Math.max(0, targetActiveWidth - activeTabState.width);
        const shrinkableTabs = layoutSnapshot.tabs.filter(tabState => tabState !== activeTabState);
        const availableShrink = shrinkableTabs.reduce(
            (total, tabState) => total + Math.max(0, tabState.width - MIN_INACTIVE_TAB_WIDTH),
            0
        );
        const usedExtraWidth = Math.min(requestedExtraWidth, availableShrink);

        targetActiveWidth = activeTabState.width + usedExtraWidth;

        const targetWidths = new Map();
        targetWidths.set(activeTabState.element, targetActiveWidth);

        shrinkableTabs.forEach(tabState => {
            const shrinkCapacity = Math.max(0, tabState.width - MIN_INACTIVE_TAB_WIDTH);
            const shrink = availableShrink > 0 ? usedExtraWidth * (shrinkCapacity / availableShrink) : 0;
            targetWidths.set(tabState.element, tabState.width - shrink);
        });

        let nextPositionX = layoutSnapshot.tabs[0]?.positionX || 0;
        let activeGeometry = null;

        layoutSnapshot.tabs.forEach((tabState, index) => {
            const previousTabState = layoutSnapshot.tabs[index - 1];
            if (previousTabState) {
                const previousOriginalEnd = previousTabState.positionX + previousTabState.width;
                nextPositionX += Math.max(0, tabState.positionX - previousOriginalEnd);
            }

            const width = targetWidths.get(tabState.element) || tabState.width;
            const widthValue = `${width}px`;
            const positionValue = `${nextPositionX}px`;

            tabState.element.classList.toggle(TAB_POSITION_CLASS, tabState === activeTabState);
            tabState.element.style.setProperty('--Width', widthValue);
            tabState.element.style.setProperty('--PositionX', positionValue);
            tabState.appliedInlineWidth = widthValue;
            tabState.appliedInlinePositionX = positionValue;

            if (tabState === activeTabState) {
                activeGeometry = {
                    left: tabState.viewportLeft - tabState.positionX + nextPositionX,
                    top: tabState.viewportTop,
                    width,
                    height: tabState.height
                };
            }

            nextPositionX += width;
        });

        return activeGeometry;
    }

    function refreshExpandedTabLayout(tab, field) {
        const activeTabPosition = getTabPosition(tab);
        if (!activeTabPosition) return null;

        if (layoutSnapshot && !isLayoutSnapshotCurrent(tab, activeTabPosition)) {
            clearExpandedTabLayout({restore: !hasExternalTabLayoutChange()});
            tab.classList.add(TAB_CLASS);
            updateProjectedAddressField(tab, field);
            void field.offsetWidth;
        }

        return updateExpandedTabLayout(tab);
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
            left: activeTabState.viewportLeft,
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

        const closingGeometry = getOriginalActiveTabGeometry();
        clearExpandedTabLayout();
        setProjectedAddressFieldGeometry(field, closingGeometry);

        if (browser) {
            browser.classList.remove(OPEN_CLASS);
            closeTransitionTimer = window.setTimeout(() => {
                resetAddressFieldProjection(field);
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
        updateProjectedAddressField(tab, field);
        tab.classList.add(TAB_CLASS);
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

        browser.classList.toggle(ROOT_CLASS, ENABLED && isHorizontalTabBar(browser));
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

        if (!browser || !field) {
            setTimeout(init, 500);
            return;
        }

        addressField = field;
        browser.classList.add(ROOT_CLASS);

        document.addEventListener('pointerdown', handlePointerDown, true);
        document.addEventListener('keydown', handleKeyDown, true);
        window.addEventListener('resize', () => schedule(refresh), true);
        field.addEventListener('focusout', handleFocusOut, true);

        observer = new MutationObserver(() => schedule(refresh));
        observer.observe(browser, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class']
        });

        refresh();
    }

    setTimeout(init, 500);
})();
