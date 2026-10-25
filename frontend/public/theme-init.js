// Runs before the page is painted (loaded from <head>) so a dark theme never flashes white.
// Mirrors applyTheme() in src/theme.js; kept as a plain file because the Content-Security-Policy
// allows scripts only from this origin, not inline ones.
(function () {
  try {
    var stored = localStorage.getItem('theme');
    var dark = stored === 'dark' || (stored !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) {
      document.documentElement.classList.add('dark');
      var bar = document.querySelector('meta[name="theme-color"]');
      if (bar) bar.setAttribute('content', '#0b1120');
    }
  } catch (e) {
    /* storage or matchMedia unavailable: the light theme is the default */
  }
})();
