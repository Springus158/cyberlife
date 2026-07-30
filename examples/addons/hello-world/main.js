// Cyber Life example addon. The default export is called once at startup
// with the addon context; the optional returned function runs on deactivate.

export default function activate(cl) {
  async function render(el) {
    let projectCount = '?';
    try {
      const res = await cl.api('/api/projects');
      projectCount = (res.projects || res || []).length;
    } catch (err) {
      cl.log('projects fetch failed:', err);
    }
    const clicks = (await cl.storage.get('clicks')) || 0;
    el.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:0.5em;">
        <div>👋 Hello from an addon! You have <b>${projectCount}</b> projects.</div>
        <button class="hw-btn">Clicked ${clicks}×</button>
      </div>
    `;
    el.querySelector('.hw-btn').addEventListener('click', async () => {
      await cl.storage.set('clicks', clicks + 1);
      render(el);
    });
  }

  cl.registerWidget({ id: 'greeting', title: 'Hello World', icon: '👋', dashboard: true, render });

  cl.registerModule({
    id: 'page',
    label: 'Hello',
    icon: '👋',
    render(el) {
      el.innerHTML = `
        <h2 style="margin-bottom:0.5em;">👋 Hello World addon page</h2>
        <p>This whole page comes from <code>~/.cyberlife/addons/hello-world/main.js</code>.
        It gets a tab, a digit shortcut, palette entry and reorder support for free.</p>
      `;
    },
    onKey(e) {
      if (e.key === 'r') {
        cl.log('r pressed on the Hello page');
        return true;
      }
      return false;
    },
  });

  cl.registerSettingsSection({
    id: 'settings',
    label: 'Hello World',
    icon: '👋',
    async render(el) {
      const loud = (await cl.storage.get('loud')) || false;
      el.innerHTML = `
        <h2 class="settings-section-title">👋 Hello World</h2>
        <p class="settings-section-desc">Example addon settings section — values persist in the addon's storage.</p>
        <label class="settings-checkbox">
          <input type="checkbox" id="hwLoud" ${loud ? 'checked' : ''}>
          <span>Greet loudly</span>
        </label>
      `;
      el.querySelector('#hwLoud').addEventListener('change', (e) => cl.storage.set('loud', e.target.checked));
    },
  });

  cl.events.on('projects-changed', () => cl.log('projects changed'));

  return () => cl.log('deactivated');
}
