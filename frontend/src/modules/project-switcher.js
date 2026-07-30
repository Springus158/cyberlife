// Project Switcher - centralized project state management
//
// This module orchestrates project switching with a handler registration system.
// Each module registers its own handler to manage its state during project transitions.

import { state } from './state.js';
import { GetProject, SetActiveProject } from '../../wailsjs/go/main/App';

// Registered handlers sorted by priority (lower = earlier)
const handlers = new Map();

/**
 * Register a state handler for project switching
 * @param {string} name - Handler name (for debugging)
 * @param {object} config - Handler configuration
 * @param {number} config.priority - Execution priority (lower = earlier, default 100)
 * @param {function} [config.onBeforeSwitch] - Called before switching (cleanup, hide UI)
 * @param {function} [config.onSave] - Called to save current project state
 * @param {function} [config.onLoad] - Called to load new project state
 * @param {function} [config.onAfterSwitch] - Called after switching (final UI updates)
 */
export function registerStateHandler(name, config) {
  handlers.set(name, {
    name,
    priority: config.priority ?? 100,
    onBeforeSwitch: config.onBeforeSwitch || null,
    onSave: config.onSave || null,
    onLoad: config.onLoad || null,
    onAfterSwitch: config.onAfterSwitch || null
  });

  console.log(`[ProjectSwitcher] Registered handler: ${name} (priority ${config.priority ?? 100})`);
}

/**
 * Unregister a state handler
 * @param {string} name - Handler name
 */
export function unregisterStateHandler(name) {
  handlers.delete(name);
}

/**
 * Get all handlers sorted by priority
 * @returns {Array} Sorted handlers
 */
function getSortedHandlers() {
  return Array.from(handlers.values()).sort((a, b) => a.priority - b.priority);
}

/**
 * Execute a lifecycle hook on all handlers
 * @param {string} hookName - Hook name (onBeforeSwitch, onSave, onLoad, onAfterSwitch)
 * @param {object} ctx - Context object passed to handlers
 */
async function executeHook(hookName, ctx) {
  const sortedHandlers = getSortedHandlers();

  for (const handler of sortedHandlers) {
    if (handler[hookName]) {
      try {
        await handler[hookName](ctx);
      } catch (err) {
        console.error(`[ProjectSwitcher] Error in ${handler.name}.${hookName}:`, err);
        // Continue with other handlers - don't let one failure block the switch
      }
    }
  }
}

/**
 * Switch to a different project
 * This is the main entry point for project switching.
 *
 * Lifecycle:
 * 1. onBeforeSwitch - cleanup, hide UI
 * 2. onSave - save current project state (if switching from existing project)
 * 3. Update state.activeProject
 * 4. onLoad - load new project state from backend
 * 5. onAfterSwitch - final UI updates
 * 6. Notify backend
 *
 * @param {string} projectId - ID of the project to switch to
 * @returns {Promise<boolean>} True if switch was successful
 */
export async function switchProject(projectId) {
  // Don't switch if already on this project
  if (state.activeProject?.id === projectId) {
    return true;
  }

  const previousProjectId = state.activeProject?.id;
  const project = state.projects.find(p => p.id === projectId);

  if (!project) {
    console.error(`[ProjectSwitcher] Project not found: ${projectId}`);
    return false;
  }

  console.log(`[ProjectSwitcher] Switching from ${previousProjectId || 'none'} to ${projectId}`);

  const ctx = {
    previousProjectId,
    newProjectId: projectId,
    previousProject: state.activeProject,
    newProject: project,
    projectState: null // Will be populated after GetProject
  };

  // Phase 1: Before switch - cleanup and hide UI
  await executeHook('onBeforeSwitch', ctx);

  // Phase 2: Save current project state (if we have an active project)
  if (previousProjectId) {
    await executeHook('onSave', { ...ctx, projectId: previousProjectId });
  }

  // Phase 3: Update active project
  state.activeProject = project;

  // Load project state from backend
  const projectState = await GetProject(projectId);
  ctx.projectState = projectState;

  // Phase 4: Load new project state
  await executeHook('onLoad', ctx);

  // Phase 5: After switch - final UI updates
  await executeHook('onAfterSwitch', ctx);

  // Phase 6: Notify backend
  await SetActiveProject(projectId);

  console.log(`[ProjectSwitcher] Switch complete to ${projectId}`);

  return true;
}

/**
 * Get debug info about registered handlers
 * @returns {Array} Handler info
 */
export function getHandlerInfo() {
  return getSortedHandlers().map(h => ({
    name: h.name,
    priority: h.priority,
    hooks: {
      onBeforeSwitch: !!h.onBeforeSwitch,
      onSave: !!h.onSave,
      onLoad: !!h.onLoad,
      onAfterSwitch: !!h.onAfterSwitch
    }
  }));
}
