(() => {
  let count = 0;
  const valueEl = document.getElementById("counter-value");
  const btnEl = document.getElementById("increment-btn");

  if (btnEl && valueEl) {
    btnEl.addEventListener("click", () => {
      count += 1;
      valueEl.textContent = String(count);
    });
  }

  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  setText("probe-origin", window.location.origin);
  setText("probe-omp-desktop", typeof window.ompDesktop);
  setText("probe-ipc", typeof window.ipc);
  setText("probe-tauri", typeof window.__TAURI_INTERNALS__);
})();
