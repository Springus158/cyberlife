// Terminal color themes for the iTerm2 output viewer
export const TERMINAL_THEMES = [
  { name: 'claude',     displayName: 'Claude',      color: '#d97706', background: '#1a1a2e', foreground: '#e0def4' },
  { name: 'dracula',    displayName: 'Dracula',     color: '#bd93f9', background: '#282a36', foreground: '#f8f8f2' },
  { name: 'gruvbox',    displayName: 'Gruvbox',     color: '#fabd2f', background: '#282828', foreground: '#ebdbb2' },
  { name: 'nord',       displayName: 'Nord',        color: '#88c0d0', background: '#2e3440', foreground: '#d8dee9' },
  { name: 'monokai',    displayName: 'Monokai',     color: '#a6e22e', background: '#272822', foreground: '#f8f8f2' },
  { name: 'solarized',  displayName: 'Solarized',   color: '#268bd2', background: '#002b36', foreground: '#839496' },
  { name: 'tokyonight', displayName: 'Tokyo Night', color: '#7aa2f7', background: '#1a1b26', foreground: '#a9b1d6' },
  { name: 'catppuccin', displayName: 'Catppuccin',  color: '#cba6f7', background: '#1e1e2e', foreground: '#cdd6f4' },
];

export function getThemeByName(name) {
  return TERMINAL_THEMES.find(t => t.name === name) || TERMINAL_THEMES[1]; // default: dracula
}
