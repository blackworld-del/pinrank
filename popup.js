/* PinRank popup: shows how many pins are saved and exports them as one CSV. */
(() => {
  const KEY = "pinrank:saved";
  const X = globalThis.PinRankExtract;

  const count = document.getElementById("count");
  const exportButton = document.getElementById("export");
  const clearButton = document.getElementById("clear");

  let records = {};

  function render() {
    const total = Object.keys(records).length;

    count.textContent = total === 1 ? "1 pin saved" : total + " pins saved";
    exportButton.disabled = total === 0;
    clearButton.disabled = total === 0;
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
    if (!confirm("Remove all " + total + " saved pins? Export the CSV first if you want a copy.")) {
      return;
    }

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
