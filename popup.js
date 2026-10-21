/* PinRank popup: shows how many pins are saved and exports them as one CSV. */
(() => {
  const KEY = "pinrank:saved";
  const X = globalThis.PinRankExtract;

  const count = document.getElementById("count");
  const exportButton = document.getElementById("export");
  const clearButton = document.getElementById("clear");

  let records = {};
  let confirmTimer = 0;

  function render() {
    const total = Object.keys(records).length;

    count.textContent = total === 1 ? "1 pin saved" : total + " pins saved";
    exportButton.disabled = total === 0;
    clearButton.disabled = total === 0;
    if (!confirmTimer) clearButton.textContent = "Clear";
  }

  function read() {
    chrome.storage.local.get(KEY, (result) => {
      records = (result && result[KEY]) || {};
      render();
    });
  }

  exportButton.addEventListener("click", () => {
    const rows = Object.values(records).sort((a, b) =>
      String(a.savedAt || "").localeCompare(String(b.savedAt || ""))
    );
    if (!rows.length) return;

    // The BOM makes Excel read the file as UTF-8 instead of the local codepage.
    const csv = "\ufeff" + X.toCsv(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "pinrank-saved-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });

  clearButton.addEventListener("click", () => {
    const total = Object.keys(records).length;
    if (!total) return;

    // No window.confirm(): a dialog can close the popup before it returns.
    if (!confirmTimer) {
      clearButton.textContent = "Click again to clear";
      confirmTimer = setTimeout(() => {
        confirmTimer = 0;
        clearButton.textContent = "Clear";
      }, 4000);
      return;
    }

    clearTimeout(confirmTimer);
    confirmTimer = 0;
    clearButton.textContent = "Clear";
    chrome.storage.local.remove(KEY, read);
  });

  if (chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace !== "local" || !changes[KEY]) return;
      records = changes[KEY].newValue || {};
      render();
    });
  }

  read();
})();
