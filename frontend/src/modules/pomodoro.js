// Pomodoro Timer Module

import { state } from './state.js';

let timerInterval = null;
let alarmInterval = null;
let settingsOpen = false; // Track if settings panel is open
let pomodoroCallbacks = {
  saveSettings: async () => {},
  loadSettings: async () => ({ sessionMinutes: 25, breakMinutes: 5 })
};

export function setPomodoroCallbacks(callbacks) {
  pomodoroCallbacks = { ...pomodoroCallbacks, ...callbacks };
}

// Load saved settings from backend
export async function loadPomodoroSettings() {
  try {
    const settings = await pomodoroCallbacks.loadSettings();
    if (settings) {
      state.pomodoro.sessionMinutes = settings.sessionMinutes || 25;
      state.pomodoro.breakMinutes = settings.breakMinutes || 5;
      // Reset timer to session time if not running
      if (!state.pomodoro.isRunning) {
        state.pomodoro.timeRemaining = state.pomodoro.sessionMinutes * 60;
      }
    }
  } catch (err) {
    console.error('Failed to load pomodoro settings:', err);
  }
}

// Save settings to backend
async function saveSettings() {
  try {
    await pomodoroCallbacks.saveSettings(state.pomodoro.sessionMinutes, state.pomodoro.breakMinutes);
  } catch (err) {
    console.error('Failed to save pomodoro settings:', err);
  }
}

// Format seconds to MM:SS
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Play notification sound using Web Audio API
function playNotificationSound() {
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();

    // Play a pleasant chime sequence
    const playTone = (frequency, startTime, duration) => {
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.frequency.value = frequency;
      oscillator.type = 'sine';

      // Fade in and out for smoother sound
      gainNode.gain.setValueAtTime(0, startTime);
      gainNode.gain.linearRampToValueAtTime(0.3, startTime + 0.05);
      gainNode.gain.linearRampToValueAtTime(0, startTime + duration);

      oscillator.start(startTime);
      oscillator.stop(startTime + duration);
    };

    const now = audioContext.currentTime;
    // Play a pleasant 3-note chime (C5, E5, G5)
    playTone(523.25, now, 0.2);        // C5
    playTone(659.25, now + 0.15, 0.2); // E5
    playTone(783.99, now + 0.3, 0.3);  // G5

  } catch (err) {
    console.log('Could not play notification sound:', err);
  }
}

// Start looping alarm sound
function startAlarmLoop() {
  stopAlarmLoop();
  playNotificationSound();
  alarmInterval = setInterval(playNotificationSound, 3000);
}

// Stop looping alarm sound
function stopAlarmLoop() {
  if (alarmInterval) {
    clearInterval(alarmInterval);
    alarmInterval = null;
  }
}

// Start the timer
function startTimer() {
  if (timerInterval) return;

  state.pomodoro.isRunning = true;
  state.pomodoro.isCompleted = false;

  timerInterval = setInterval(() => {
    if (state.pomodoro.timeRemaining > 0) {
      state.pomodoro.timeRemaining--;
      renderPomodoro();
    } else {
      // Timer completed
      clearInterval(timerInterval);
      timerInterval = null;
      state.pomodoro.isRunning = false;
      state.pomodoro.isCompleted = true;
      startAlarmLoop();
      renderPomodoro();
    }
  }, 1000);

  renderPomodoro();
}

// Toggle start/pause
export function togglePomodoro() {
  if (state.pomodoro.isRunning) {
    pauseTimer();
  } else {
    startTimer();
  }
}

// Pause the timer
function pauseTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  state.pomodoro.isRunning = false;
  renderPomodoro();
}

// Reset timer
function resetTimer() {
  stopAlarmLoop();
  pauseTimer();
  state.pomodoro.isBreak = false;
  state.pomodoro.isCompleted = false;
  state.pomodoro.timeRemaining = state.pomodoro.sessionMinutes * 60;
  renderPomodoro();
}

// Acknowledge completion and start break or new session
function acknowledgeComplete() {
  stopAlarmLoop();
  state.pomodoro.isCompleted = false;

  if (state.pomodoro.isBreak) {
    // Break finished, start new session
    state.pomodoro.isBreak = false;
    state.pomodoro.timeRemaining = state.pomodoro.sessionMinutes * 60;
  } else {
    // Session finished, start break
    state.pomodoro.isBreak = true;
    state.pomodoro.timeRemaining = state.pomodoro.breakMinutes * 60;
  }

  renderPomodoro();
}

// Update session time
async function updateSessionTime(minutes) {
  state.pomodoro.sessionMinutes = minutes;
  if (!state.pomodoro.isRunning && !state.pomodoro.isBreak) {
    state.pomodoro.timeRemaining = minutes * 60;
  }
  await saveSettings();
  renderPomodoro();
}

// Update break time
async function updateBreakTime(minutes) {
  state.pomodoro.breakMinutes = minutes;
  if (!state.pomodoro.isRunning && state.pomodoro.isBreak) {
    state.pomodoro.timeRemaining = minutes * 60;
  }
  await saveSettings();
  renderPomodoro();
}

// Render the pomodoro section
export function renderPomodoro() {
  const container = document.getElementById('pomodoroSection');
  console.log('[Pomodoro] renderPomodoro called, container:', container);
  if (!container) {
    console.log('[Pomodoro] pomodoroSection not found!');
    return;
  }

  const { sessionMinutes, breakMinutes, isRunning, isBreak, timeRemaining, isCompleted } = state.pomodoro;
  const timeDisplay = formatTime(timeRemaining);
  const progress = isBreak
    ? ((breakMinutes * 60 - timeRemaining) / (breakMinutes * 60)) * 100
    : ((sessionMinutes * 60 - timeRemaining) / (sessionMinutes * 60)) * 100;

  container.innerHTML = `
    <div class="pomodoro-container ${isCompleted ? 'pulsing' : ''} ${isBreak ? 'break-mode' : ''}">
      <div class="pomodoro-header">
        <span class="pomodoro-icon">${isBreak ? '☕' : '🍅'}</span>
        <span class="pomodoro-title">${isBreak ? 'Break' : 'Focus'}</span>
        <button class="pomodoro-settings-btn" id="pomodoroSettingsBtn" title="Settings">⚙️</button>
      </div>

      <div class="pomodoro-timer">
        <div class="pomodoro-progress" style="--progress: ${progress}%"></div>
        <span class="pomodoro-time">${timeDisplay}</span>
      </div>

      ${isCompleted ? `
        <div class="pomodoro-complete">
          <span>${isBreak ? 'Break over!' : 'Great work!'}</span>
          <button class="pomodoro-ok-btn" id="pomodoroOkBtn">OK</button>
        </div>
      ` : `
        <div class="pomodoro-controls">
          ${isRunning ? `
            <button class="pomodoro-btn pause" id="pomodoroPauseBtn" title="Pause">⏸</button>
          ` : `
            <button class="pomodoro-btn play" id="pomodoroStartBtn" title="Start">▶</button>
          `}
          <button class="pomodoro-btn reset" id="pomodoroResetBtn" title="Reset">↺</button>
        </div>
      `}

      <div class="pomodoro-settings ${settingsOpen ? '' : 'hidden'}" id="pomodoroSettings">
        <div class="pomodoro-setting">
          <label>Session</label>
          <div class="setting-control">
            <button class="setting-btn" data-action="session-down">−</button>
            <span id="sessionDisplay">${sessionMinutes}m</span>
            <button class="setting-btn" data-action="session-up">+</button>
          </div>
        </div>
        <div class="pomodoro-setting">
          <label>Break</label>
          <div class="setting-control">
            <button class="setting-btn" data-action="break-down">−</button>
            <span id="breakDisplay">${breakMinutes}m</span>
            <button class="setting-btn" data-action="break-up">+</button>
          </div>
        </div>
      </div>
    </div>
  `;

  setupPomodoroListeners();
}

// Setup event listeners
function setupPomodoroListeners() {
  const startBtn = document.getElementById('pomodoroStartBtn');
  const pauseBtn = document.getElementById('pomodoroPauseBtn');
  const resetBtn = document.getElementById('pomodoroResetBtn');
  const okBtn = document.getElementById('pomodoroOkBtn');
  const settingsBtn = document.getElementById('pomodoroSettingsBtn');
  const settingsPanel = document.getElementById('pomodoroSettings');

  startBtn?.addEventListener('click', () => {
    settingsOpen = false; // Close settings when starting
    startTimer();
  });
  pauseBtn?.addEventListener('click', pauseTimer);
  resetBtn?.addEventListener('click', resetTimer);
  okBtn?.addEventListener('click', acknowledgeComplete);

  settingsBtn?.addEventListener('click', () => {
    settingsOpen = !settingsOpen;
    settingsPanel?.classList.toggle('hidden', !settingsOpen);
  });

  // Setting buttons
  document.querySelectorAll('.setting-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const action = e.target.dataset.action;
      switch (action) {
        case 'session-up':
          if (state.pomodoro.sessionMinutes < 60) await updateSessionTime(state.pomodoro.sessionMinutes + 5);
          break;
        case 'session-down':
          if (state.pomodoro.sessionMinutes > 5) await updateSessionTime(state.pomodoro.sessionMinutes - 5);
          break;
        case 'break-up':
          if (state.pomodoro.breakMinutes < 30) await updateBreakTime(state.pomodoro.breakMinutes + 1);
          break;
        case 'break-down':
          if (state.pomodoro.breakMinutes > 1) await updateBreakTime(state.pomodoro.breakMinutes - 1);
          break;
      }
    });
  });
}

// Add styles
export function addPomodoroStyles() {
  if (document.getElementById('pomodoro-styles')) return;

  const style = document.createElement('style');
  style.id = 'pomodoro-styles';
  style.textContent = `
    #pomodoroSection {
      padding: 0;
      border-bottom: 1px solid var(--border);
    }

    .pomodoro-container {
      padding: 12px;
      transition: background 0.3s;
    }

    .pomodoro-container.pulsing {
      animation: pomodoro-pulse 1s ease-in-out infinite;
    }

    .pomodoro-container.break-mode {
      background: rgba(34, 197, 94, 0.1);
    }

    @keyframes pomodoro-pulse {
      0%, 100% { background: rgba(239, 68, 68, 0.2); }
      50% { background: rgba(239, 68, 68, 0.4); }
    }

    .pomodoro-container.break-mode.pulsing {
      animation: pomodoro-pulse-break 1s ease-in-out infinite;
    }

    @keyframes pomodoro-pulse-break {
      0%, 100% { background: rgba(34, 197, 94, 0.2); }
      50% { background: rgba(34, 197, 94, 0.4); }
    }

    .pomodoro-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }

    .pomodoro-icon {
      font-size: 20px;
    }

    .pomodoro-title {
      font-weight: 600;
      font-size: 14px;
      color: var(--text-primary);
      flex: 1;
    }

    .pomodoro-settings-btn {
      background: none;
      border: none;
      font-size: 14px;
      cursor: pointer;
      opacity: 0.6;
      transition: opacity 0.2s;
      padding: 4px;
    }

    .pomodoro-settings-btn:hover {
      opacity: 1;
    }

    .pomodoro-timer {
      position: relative;
      text-align: center;
      padding: 16px 0;
      background: var(--bg-primary);
      border-radius: 8px;
      margin-bottom: 12px;
      overflow: hidden;
    }

    .pomodoro-progress {
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      width: var(--progress);
      background: rgba(239, 68, 68, 0.15);
      transition: width 1s linear;
    }

    .break-mode .pomodoro-progress {
      background: rgba(34, 197, 94, 0.15);
    }

    .pomodoro-time {
      position: relative;
      font-size: 32px;
      font-weight: 700;
      font-family: 'SF Mono', 'Monaco', 'Menlo', monospace;
      color: var(--text-primary);
      letter-spacing: 2px;
    }

    .pomodoro-controls {
      display: flex;
      justify-content: center;
      gap: 12px;
    }

    .pomodoro-btn {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      border: none;
      cursor: pointer;
      font-size: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.1s, background 0.2s;
    }

    .pomodoro-btn:hover {
      transform: scale(1.1);
    }

    .pomodoro-btn:active {
      transform: scale(0.95);
    }

    .pomodoro-btn.play {
      background: #22c55e;
      color: white;
    }

    .pomodoro-btn.pause {
      background: #f59e0b;
      color: white;
    }

    .pomodoro-btn.reset {
      background: var(--bg-tertiary);
      color: var(--text-secondary);
    }

    .pomodoro-complete {
      text-align: center;
    }

    .pomodoro-complete span {
      display: block;
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 12px;
    }

    .pomodoro-ok-btn {
      padding: 8px 32px;
      background: #22c55e;
      color: white;
      border: none;
      border-radius: 6px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }

    .pomodoro-ok-btn:hover {
      background: #16a34a;
    }

    .pomodoro-settings {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--border);
    }

    .pomodoro-settings.hidden {
      display: none;
    }

    .pomodoro-setting {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }

    .pomodoro-setting:last-child {
      margin-bottom: 0;
    }

    .pomodoro-setting label {
      font-size: 12px;
      color: var(--text-secondary);
    }

    .setting-control {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .setting-control span {
      font-size: 13px;
      font-weight: 600;
      min-width: 36px;
      text-align: center;
      color: var(--text-primary);
    }

    .setting-btn {
      width: 24px;
      height: 24px;
      border-radius: 4px;
      border: 1px solid var(--border);
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.2s;
    }

    .setting-btn:hover {
      background: var(--bg-hover);
    }
  `;
  document.head.appendChild(style);
}

// Initialize pomodoro
export function initPomodoro() {
  console.log('[Pomodoro] initPomodoro called');
  addPomodoroStyles();
  loadPomodoroSettings().then(() => {
    console.log('[Pomodoro] Settings loaded, rendering...');
    renderPomodoro();
  }).catch(err => {
    console.error('[Pomodoro] Failed to load settings:', err);
    renderPomodoro(); // Still render with defaults
  });
}
