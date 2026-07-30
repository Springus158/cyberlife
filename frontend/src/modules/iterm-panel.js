/**
 * iTerm2 Integration Panel
 * Simple tab buttons - click to switch, double-click to rename
 */

import { GetITermStatus, LaunchITerm, CreateITermTab, SwitchITermTabBySessionID, RenameITermTabBySessionID, FocusITerm } from '../../wailsjs/go/main/App';
import { state } from './state.js';

let itermStatus = { running: false, tabs: [] };
let panelContainer = null;
let initialized = false;

/**
 * Initialize the iTerm panel module
 */
export function initITermPanel() {
    if (initialized) return;
    initialized = true;
    fetchITermStatus();
}

/**
 * Fetch the current iTerm2 status
 */
async function fetchITermStatus() {
    try {
        itermStatus = await GetITermStatus();
        renderITermPanel();
    } catch (err) {
        console.error('Failed to fetch iTerm2 status:', err);
    }
}

function getActiveProjectPath() {
    return state.activeProject?.path || '';
}

function getActiveProjectName() {
    return state.activeProject?.name || 'project';
}

function getProjectTabs() {
    return itermStatus.tabs || [];
}

function getNextTabNumber() {
    return (itermStatus.tabs || []).length + 1;
}

async function handleLaunchITerm() {
    try {
        await LaunchITerm();
    } catch (err) {
        console.error('Failed to launch iTerm2:', err);
    }
}

async function handleCreateTab() {
    const projectPath = getActiveProjectPath();
    const projectName = getActiveProjectName();
    if (!projectPath) return;

    const tabName = `${projectName} ${getNextTabNumber()}`;
    try {
        await CreateITermTab(projectPath, tabName);
        setTimeout(fetchITermStatus, 500);
    } catch (err) {
        console.error('Failed to create iTerm2 tab:', err);
    }
}

async function handleSwitchTab(sessionId) {
    // Instant UI update
    if (itermStatus.tabs) {
        itermStatus.tabs.forEach(tab => {
            tab.isActive = (tab.sessionId === sessionId);
        });
        updateActiveStates();
    }

    try {
        await SwitchITermTabBySessionID(sessionId);
        // Silent sync
        const freshStatus = await GetITermStatus();
        const namesChanged = JSON.stringify(freshStatus.tabs?.map(t => t.name)) !==
                            JSON.stringify(itermStatus.tabs?.map(t => t.name));
        itermStatus = freshStatus;
        if (namesChanged) renderITermPanel();
    } catch (err) {
        console.error('Failed to switch iTerm2 tab:', err);
    }
}

async function handleRenameTab(sessionId, currentName) {
    const newName = prompt('Rename tab:', currentName);
    if (!newName || newName === currentName) return;

    try {
        await RenameITermTabBySessionID(sessionId, newName);
        const tab = itermStatus.tabs?.find(t => t.sessionId === sessionId);
        if (tab) {
            tab.name = newName;
            renderITermPanel();
        }
    } catch (err) {
        console.error('Failed to rename iTerm2 tab:', err);
    }
}

async function handleFocusITerm() {
    try {
        await FocusITerm();
    } catch (err) {
        console.error('Failed to focus iTerm2:', err);
    }
}

export async function focusProjectTab() {
    if (!itermStatus.running) return;
    const tabs = getProjectTabs();
    if (tabs.length === 0) return;

    const targetTab = tabs.find(t => t.isActive) || tabs[0];
    try {
        await SwitchITermTabBySessionID(targetTab.sessionId);
    } catch (err) {
        console.error('Failed to focus project tab:', err);
    }
}

function updateActiveStates() {
    if (!panelContainer) return;
    const tabs = getProjectTabs();
    const btns = panelContainer.querySelectorAll('.iterm-tab-btn[data-session]');
    btns.forEach((btn, i) => {
        const tab = tabs[i];
        if (tab) btn.classList.toggle('active', tab.isActive);
    });
}

export function renderITermPanel() {
    if (!panelContainer) {
        panelContainer = document.getElementById('iterm-panel');
    }
    if (!panelContainer) return;

    const tabs = getProjectTabs();

    panelContainer.innerHTML = '';

    const row = document.createElement('div');
    row.className = 'iterm-tabs-row';

    if (!itermStatus.running) {
        const btn = document.createElement('button');
        btn.className = 'iterm-tab-btn';
        btn.textContent = 'Open iTerm2';
        btn.onclick = handleLaunchITerm;
        row.appendChild(btn);
    } else {
        tabs.forEach(tab => {
            const btn = document.createElement('button');
            btn.className = 'iterm-tab-btn' + (tab.isActive ? ' active' : '');
            btn.textContent = tab.name;
            btn.setAttribute('data-session', tab.sessionId);

            // Single click = switch tab
            btn.onclick = () => handleSwitchTab(tab.sessionId);

            // Double click = rename
            btn.ondblclick = (e) => {
                e.preventDefault();
                handleRenameTab(tab.sessionId, tab.name);
            };

            row.appendChild(btn);
        });
    }

    panelContainer.appendChild(row);
}

// Global functions for external use
window.itermFocus = handleFocusITerm;
window.itermRefresh = fetchITermStatus;
window.itermRenameTab = handleRenameTab;

export { itermStatus, fetchITermStatus };
