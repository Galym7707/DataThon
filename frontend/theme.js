/* Runs before stylesheets to avoid painting the wrong theme on reload. */
(() => {
  const t = value=>window.CQA_I18N?.t(value) ?? value;
  const key = 'freedom-cqa-theme';
  const root = document.documentElement;
  const valid = value => value === 'light' || value === 'dark';
  function apply(theme, persist = false) {
    const selected = valid(theme) ? theme : 'light';
    root.dataset.theme = selected;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = selected === 'dark' ? '#0f172a' : '#f4f7fa';
    const button = document.getElementById('theme-toggle');
    if (button) {
      const dark = selected === 'dark';
      button.setAttribute('aria-pressed', String(dark));
      button.setAttribute('aria-label', t(dark ? 'Включить светлую тему' : 'Включить тёмную тему'));
      button.title = t(dark ? 'Тёмная тема. Переключить на светлую' : 'Светлая тема. Переключить на тёмную');
      button.querySelector('.theme-toggle-label').textContent = t(dark ? 'Тёмная' : 'Светлая');
    }
    if (persist) {
      try { localStorage.setItem(key, selected); } catch { /* Session toggle still works. */ }
    }
  }
  let saved;
  try { saved = localStorage.getItem(key); } catch { /* Light is also the privacy-mode fallback. */ }
  apply(saved);
  document.addEventListener('DOMContentLoaded', () => {
    apply(root.dataset.theme);
    document.getElementById('theme-toggle').addEventListener('click', () => {
      apply(root.dataset.theme === 'dark' ? 'light' : 'dark', true);
    });
  });
  window.addEventListener('cqa-language-change',()=>apply(root.dataset.theme));
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) apply(event.key === null ? 'light' : event.newValue);
  });
})();
