// theme-toggle.js
// Toggles [data-theme="dark"] on <html> and swaps the sun/moon icon.

document.addEventListener('DOMContentLoaded', function () {
  const toggleBtn = document.querySelector('.btn.theme-toggle');
  const sunIcon   = document.querySelector('.theme-icon--sun');
  const moonIcon  = document.querySelector('.theme-icon--moon');
  const root      = document.documentElement;

  if (!toggleBtn) return;

  const saved = localStorage.getItem('beatbox-theme');
  if (saved === 'dark') applyDark();

  toggleBtn.addEventListener('click', function () {
    if (root.dataset.theme === 'dark') {
      applyLight();
      localStorage.setItem('beatbox-theme', 'light');
    } else {
      applyDark();
      localStorage.setItem('beatbox-theme', 'dark');
    }
  });

  function applyDark() {
    root.dataset.theme = 'dark';
    if (sunIcon)  sunIcon.style.display  = 'none';
    if (moonIcon) moonIcon.style.display = '';
  }

  function applyLight() {
    delete root.dataset.theme;
    if (sunIcon)  sunIcon.style.display  = '';
    if (moonIcon) moonIcon.style.display = 'none';
  }
});
