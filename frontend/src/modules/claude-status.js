import { state } from './state.js';

// Claude status UI functions
export function updateClaudeStatusUI(terminalId) {
  const terminalTab = document.querySelector(`.terminal-tab[data-id="${terminalId}"]`);
  if (terminalTab) {
    updateClaudeStatusElement(terminalTab, terminalId);
  }

  const terminalItem = document.querySelector(`.terminal-item[data-id="${terminalId}"]`);
  if (terminalItem) {
    updateClaudeStatusElement(terminalItem, terminalId);
  }

  // Find which project this terminal belongs to and update its tab
  for (const [projectId, terminals] of state.projectTerminals) {
    if (terminals.has(terminalId)) {
      const projectTab = document.querySelector(`.project-tab[data-id="${projectId}"]`);
      if (projectTab) {
        updateProjectClaudeStatus(projectTab, projectId);
      }
      break;
    }
  }
}

function updateClaudeStatusElement(element, terminalId) {
  const status = state.claudeStatus.get(terminalId);

  const existingIndicator = element.querySelector('.claude-status-indicator');
  if (existingIndicator) {
    existingIndicator.remove();
  }

  if (!status || status === 'none') return;

  const indicator = document.createElement('span');
  indicator.className = `claude-status-indicator claude-status-${status}`;
  indicator.title = getClaudeStatusTitle(status);

  const nameEl = element.querySelector('.name');
  if (nameEl) {
    nameEl.after(indicator);
  } else {
    element.appendChild(indicator);
  }
}

export function updateProjectClaudeStatus(projectTab, projectId) {
  // Status classes removed - only active project gets green highlight via CSS
}

export function getClaudeStatusTitle(status) {
  switch (status) {
    case 'working': return 'Claude is working...';
    case 'idle': return 'Claude is ready';
    case 'needs_action': return 'Claude needs your input';
    default: return '';
  }
}

// Update all project claude status
export function updateAllProjectClaudeStatus() {
  for (const [projectId] of state.projectTerminals) {
    const projectTab = document.querySelector(`.project-tab[data-id="${projectId}"]`);
    if (projectTab) {
      updateProjectClaudeStatus(projectTab, projectId);
    }
  }
}
