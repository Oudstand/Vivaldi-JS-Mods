/*
 * Safari compact address bar
 *
 * Moves the real address field into the clicked tab and returns it to the
 * tab-bar toolbar when the user clicks somewhere else.
 * Requires the address field to be placed in the tab bar via the toolbar editor.
 */
(function safari_compact_addressbar() {
    'use strict';

    const ENABLED = true;
    const ROOT_CLASS = 'safari-compact-addressbar';
    const OPEN_CLASS = 'safari-compact-addressbar-open';
    const FIELD_CLASS = 'safari-compact-addressbar-field';
    const TAB_CLASS = 'safari-compact-addressbar-tab';
    const TAB_POSITION_CLASS = 'safari-compact-addressbar-tab-position';

    const MIN_COMPACT_TAB_WIDTH = 240;
    const MAX_COMPACT_TAB_WIDTH = 340;
    const COMPACT_TAB_EXTRA_WIDTH = 160;

    let addressField = null;
    let placeholder = null;
    let observer = null;
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

    function getTabPositions() {
        return [...document.querySelectorAll('#tabs-tabbar-container .tab-position')].filter(tabPosition =>
            tabPosition.querySelector('.tab')
        );
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

    function ensurePlaceholder(field) {
        if (placeholder && document.contains(placeholder)) return;
        placeholder = document.createComment('safari-compact-addressbar-placeholder');
        field.parentNode.insertBefore(placeholder, field);
    }

    function focusUrlInput(field) {
        const input = field.querySelector('#urlFieldInput, input');
        if (!input) return;
        input.focus();
        input.select?.();
    }

    function readCssPixelValue(element, property, fallback) {
        const value = getComputedStyle(element).getPropertyValue(property).trim();
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function saveOriginalTabLayout(tabPosition) {
        if (tabPosition.dataset.safariCompactOriginalWidth !== undefined) return;

        tabPosition.dataset.safariCompactOriginalWidth = tabPosition.style.getPropertyValue('--Width');
        tabPosition.dataset.safariCompactOriginalPositionX = tabPosition.style.getPropertyValue('--PositionX');
    }

    function restoreStyleProperty(element, property, value) {
        if (value) {
            element.style.setProperty(property, value);
        } else {
            element.style.removeProperty(property);
        }
    }

    function resetTabLayout() {
        getTabPositions().forEach(tabPosition => {
            tabPosition.classList.remove(TAB_POSITION_CLASS);
            restoreStyleProperty(tabPosition, '--Width', tabPosition.dataset.safariCompactOriginalWidth);
            restoreStyleProperty(tabPosition, '--PositionX', tabPosition.dataset.safariCompactOriginalPositionX);
            delete tabPosition.dataset.safariCompactOriginalWidth;
            delete tabPosition.dataset.safariCompactOriginalPositionX;
        });
    }

    function setStyleProperty(element, property, value) {
        if (element.style.getPropertyValue(property) === value) return;
        element.style.setProperty(property, value);
    }

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function updateTabLayout(tab) {
        const tabPosition = getTabPosition(tab);
        if (!tabPosition) return;

        const tabPositions = getTabPositions();
        tabPositions.forEach(saveOriginalTabLayout);

        const originalWidth = parseFloat(tabPosition.dataset.safariCompactOriginalWidth) ||
            readCssPixelValue(tabPosition, '--Width', tabPosition.getBoundingClientRect().width);
        const originalPositionX = parseFloat(tabPosition.dataset.safariCompactOriginalPositionX) ||
            readCssPixelValue(tabPosition, '--PositionX', tabPosition.getBoundingClientRect().left);
        const targetWidth = clamp(originalWidth + COMPACT_TAB_EXTRA_WIDTH, MIN_COMPACT_TAB_WIDTH, MAX_COMPACT_TAB_WIDTH);
        const shift = Math.max(0, targetWidth - originalWidth);
        const originalWidthValue = `${targetWidth}px`;

        tabPositions.forEach(nextTabPosition => {
            const nextOriginalPositionX = parseFloat(nextTabPosition.dataset.safariCompactOriginalPositionX) ||
                readCssPixelValue(nextTabPosition, '--PositionX', nextTabPosition.getBoundingClientRect().left);

            if (nextTabPosition === tabPosition) {
                nextTabPosition.classList.add(TAB_POSITION_CLASS);
                setStyleProperty(nextTabPosition, '--Width', originalWidthValue);
                restoreStyleProperty(nextTabPosition, '--PositionX', nextTabPosition.dataset.safariCompactOriginalPositionX);
            } else {
                nextTabPosition.classList.remove(TAB_POSITION_CLASS);
                restoreStyleProperty(nextTabPosition, '--Width', nextTabPosition.dataset.safariCompactOriginalWidth);

                if (nextOriginalPositionX > originalPositionX) {
                    setStyleProperty(
                        nextTabPosition,
                        '--PositionX',
                        `calc(${nextTabPosition.dataset.safariCompactOriginalPositionX || `${nextOriginalPositionX}px`} + ${shift}px)`
                    );
                } else {
                    restoreStyleProperty(nextTabPosition, '--PositionX', nextTabPosition.dataset.safariCompactOriginalPositionX);
                }
            }
        });
    }

    function closeAddressField() {
        const browser = getBrowser();
        const field = getAddressField();
        const restoreParent = placeholder?.parentNode || document.querySelector('#tabs-container > .toolbar-tabbar-before');
        if (!field || !restoreParent) return;

        field.classList.remove(FIELD_CLASS);
        field.closest(`.${TAB_CLASS}`)?.classList.remove(TAB_CLASS);
        resetTabLayout();
        if (placeholder?.parentNode) {
            restoreParent.insertBefore(field, placeholder.nextSibling);
        } else {
            restoreParent.appendChild(field);
        }
        browser?.classList.remove(OPEN_CLASS);
    }

    function openAddressField(tab, shouldFocus = true) {
        const browser = getBrowser();
        const field = getAddressField();

        if (!ENABLED || !browser || !field || !tab || !isHorizontalTabBar(browser)) return;
        if (browser.classList.contains('toolbar-edit-mode')) return;

        ensurePlaceholder(field);
        document.querySelectorAll(`.${TAB_CLASS}`).forEach(activeTab => activeTab.classList.remove(TAB_CLASS));
        updateTabLayout(tab);

        tab.classList.add(TAB_CLASS);
        field.classList.add(FIELD_CLASS);
        tab.appendChild(field);
        browser.classList.add(ROOT_CLASS, OPEN_CLASS);

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
            setTimeout(() => openAddressField(getActiveTab() || clickedTab), 80);
            return;
        }

        closeAddressField();
    }

    function handleKeyDown(event) {
        if (event.key === 'Escape') {
            closeAddressField();
        }
    }

    function handleFocusOut() {
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
        if (!browser.classList.contains(ROOT_CLASS) || browser.classList.contains('toolbar-edit-mode')) {
            closeAddressField();
            return;
        }

        const compactTab = document.querySelector(`.${TAB_CLASS}`);
        if (browser.classList.contains(OPEN_CLASS) && compactTab && !compactTab.classList.contains('active')) {
            closeAddressField();
            return;
        }

        if (browser.classList.contains(OPEN_CLASS) && compactTab) {
            updateTabLayout(compactTab);
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
