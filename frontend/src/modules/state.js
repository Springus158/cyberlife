// Application State - reactive view state only (backend is source of truth)
export const state = {
  projects: [],
  projectGroups: [],
  claudeAccounts: [], // Named CLAUDE_CONFIG_DIR profiles (loaded from backend)
  activeProject: null,
  activeTaskPath: null, // worktree path of the task whose terminal is being viewed (git/diff context)
  activeTaskRepos: null, // repos of the viewed multi-repo task [{repoName, worktreePath}] for the git panel switcher
  projectTerminals: new Map(), // projectId -> Map(termId -> { terminal, fitAddon, info, resizeObserver })
  activeTerminalId: null,
  activeTab: 'terminal',
  containers: [],
  colors: [],
  icons: [],
  shell: {
    activeTabId: null,  // Active module id
  },
  splitView: true, // Always show terminal + browser side by side
  splitRatio: 50,
  git: {
    isRepo: false,
    branch: '',
    changedFiles: [],
    expanded: true,
    currentDiffFile: null
  },
  claudeStatus: new Map(), // terminalId -> status
  testStatus: new Map(), // terminalId -> { runner, status, passed, failed, skipped, total, duration, coveragePercent, failedTests }
  terminalFontSize: 14, // Terminal font size
  terminalTheme: 'dracula', // Terminal color theme
  diffSelection: {
    active: false,
    pane: null,       // 'old' | 'new'
    startLine: null,
    endLine: null,
    filePath: null,
    rawLines: []      // Original line content for copying
  },
  // Notes section state
  notesExpanded: true,
  // Pomodoro timer state
  pomodoro: {
    sessionMinutes: 25,    // Default 25 min session
    breakMinutes: 5,       // Default 5 min break
    isRunning: false,
    isBreak: false,
    timeRemaining: 25 * 60, // Seconds remaining
    isCompleted: false      // True when timer hits 0, waiting for OK
  }
};

// Repo path for git/diff panels: the viewed task's worktree, or the active project
export function getActiveRepoPath() {
  return state.activeTaskPath || state.activeProject?.path || '';
}

// Helper to get current project's terminals
export function getTerminals() {
  if (!state.activeProject) return new Map();
  if (!state.projectTerminals.has(state.activeProject.id)) {
    state.projectTerminals.set(state.activeProject.id, new Map());
  }
  return state.projectTerminals.get(state.activeProject.id);
}
