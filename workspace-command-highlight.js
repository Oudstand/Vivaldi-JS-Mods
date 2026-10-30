/* Highlight workspace shortcuts independently of themes and icon format.
 * Supports native "Switch to Workspace N" buttons and command chains containing
 * those commands. The target follows Vivaldi's workspace order, like the command.
 */
(function workspace_command_highlight() {
    'use strict';

    const CHAIN_PREF = 'vivaldi.chained_commands.command_list';
    const BUTTONS = '#switch .button-toolbar > button[data-name]';

    function workspaceIndex(name) {
        const match = /^COMMAND_WORKSPACE_SWITCH_(\d+)$/.exec(name || '');
        return match ? Number(match[1]) - 2 : undefined;
    }

    function nativeStores() {
        const core = chrome.extension.getViews().find(view => view.location.href === chrome.runtime.getURL('main.html'));
        if (!core?.webpackChunkgapp_browser_react) throw new Error('Vivaldi shared context unavailable');
        let require;
        core.webpackChunkgapp_browser_react.push([[`workspace-highlight-${crypto.randomUUID()}`], {}, runtime => { require = runtime; }]);
        const find = (marker, method) => {
            const id = Object.keys(require.m).find(id => require.m[id].toString().includes(marker));
            return id && Object.values(require(id)).find(value => typeof value?.[method] === 'function');
        };
        const workspaces = find('getActiveWorkspaceId(e){', 'getActiveWorkspaceId');
        const commands = find('getCommandsForGestures(){', 'getCommands');
        if (!workspaces || !commands) throw new Error('Vivaldi workspace or command store unavailable');
        return {workspaces, commands};
    }

    class WorkspaceCommandHighlight {
        #workspaces;
        #commands;
        #targets = new Map();
        #observer;
        #frame = null;
        #disposed = false;
        #version = 0;

        constructor() {
            const {workspaces, commands} = nativeStores();
            this.#workspaces = workspaces;
            this.#commands = commands;
            workspaces.addListener(this.#schedule);
            vivaldi.prefs.onChanged.addListener(this.#onPrefChanged);
            this.#observer = new MutationObserver(mutations => {
                if (mutations.some(mutation => mutation.target.closest?.('#switch') ||
                    [...mutation.addedNodes, ...mutation.removedNodes].some(node =>
                        node.nodeType === Node.ELEMENT_NODE && (node.id === 'switch' || node.querySelector('#switch'))))) {
                    this.#schedule();
                }
            });
            this.#observer.observe(document.getElementById('browser'), {
                childList: true, subtree: true, attributes: true, attributeFilter: ['data-name']
            });
            addEventListener('unload', this.destroy, {once: true});
            this.#loadChains();
        }

        #onPrefChanged = change => {
            if ((typeof change === 'string' ? change : change.path) === CHAIN_PREF) this.#loadChains();
        };

        async #loadChains() {
            const version = ++this.#version;
            try {
                const {value} = await vivaldi.prefs.get(CHAIN_PREF);
                if (this.#disposed || version !== this.#version) return;
                const commandNames = new Map(this.#commands.getCommands().map(command => [command.guid, command.name]));
                const targets = new Map();
                for (const chain of value) {
                    // The last explicit workspace switch determines the chain's target.
                    for (const step of chain.chain) {
                        const index = workspaceIndex(commandNames.get(step.key) || step.name);
                        if (index !== undefined) targets.set(chain.name, index);
                    }
                }
                this.#targets = targets;
                this.#schedule();
            } catch (error) {
                if (!this.#disposed) console.warn('Workspace highlight: Failed to read command chains:', error);
            }
        }

        #schedule = () => {
            if (this.#disposed || this.#frame !== null) return;
            this.#frame = requestAnimationFrame(() => {
                this.#frame = null;
                this.#render();
            });
        };

        #render() {
            const workspaces = this.#workspaces.getWorkspaces();
            const activeId = this.#workspaces.getActiveWorkspaceId(vivaldiWindowId);
            for (const button of document.querySelectorAll(BUTTONS)) {
                const name = button.dataset.name;
                const index = this.#targets.get(name) ?? workspaceIndex(name);
                const valid = index === -1 || (index >= 0 && index < workspaces.length);
                const active = valid && (index === -1 ? activeId === undefined : workspaces[index].id === activeId);
                button.parentElement.classList.toggle('workspace-command', valid);
                button.parentElement.classList.toggle('workspace-command-active', active);
            }
        }

        destroy = () => {
            this.#disposed = true;
            this.#version++;
            cancelAnimationFrame(this.#frame);
            this.#observer.disconnect();
            this.#workspaces.removeListener(this.#schedule);
            vivaldi.prefs.onChanged.removeListener(this.#onPrefChanged);
            removeEventListener('unload', this.destroy);
            document.querySelectorAll('#switch .workspace-command').forEach(button => {
                button.classList.remove('workspace-command', 'workspace-command-active');
            });
        };
    }

    window.workspaceCommandHighlight?.destroy();
    function start() {
        try {
            window.workspaceCommandHighlight = new WorkspaceCommandHighlight();
        } catch (error) {
            console.warn('Workspace highlight unavailable:', error);
        }
    }

    if (document.getElementById('browser')) start();
    else {
        const observer = new MutationObserver(() => {
            if (document.getElementById('browser')) {
                destroy();
                start();
            }
        });
        const destroy = () => {
            observer.disconnect();
            removeEventListener('unload', destroy);
        };
        // Reinjection can also happen before the native UI has finished loading.
        window.workspaceCommandHighlight = {destroy};
        observer.observe(document.documentElement, {childList: true, subtree: true});
        addEventListener('unload', destroy, {once: true});
    }
})();
