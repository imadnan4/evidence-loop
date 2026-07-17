/**
 * Small progressive-enhancement helpers for presentational primitives.
 * They never fetch data or make workflow decisions.
 */
export function initialiseCommandPalettes(root = document) {
  const palettes = root.querySelectorAll("dialog[data-command-palette]");

  for (const dialog of palettes) {
    const paletteId = dialog.id;
    const search = dialog.querySelector("[data-command-search]");
    const items = [...dialog.querySelectorAll("[data-command-item]")];
    const status = dialog.querySelector("[data-command-status]");
    const triggers = document.querySelectorAll(`[data-command-trigger="${paletteId}"]`);

    const updateResults = () => {
      const query = (search?.value ?? "").trim().toLocaleLowerCase();
      let visible = 0;
      for (const item of items) {
        const matches = item.textContent.toLocaleLowerCase().includes(query);
        item.hidden = !matches;
        if (matches) visible += 1;
      }
      if (status) status.textContent = `${visible} command${visible === 1 ? "" : "s"} available`;
    };

    const open = () => {
      if (typeof dialog.showModal !== "function") return;
      if (!dialog.open) dialog.showModal();
      updateResults();
      window.setTimeout(() => search?.focus(), 0);
    };

    for (const trigger of triggers) trigger.addEventListener("click", open);
    dialog.querySelectorAll("[data-command-close]").forEach((button) => {
      button.addEventListener("click", () => dialog.close());
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.querySelectorAll("[data-command-item]").forEach((item) => {
      item.addEventListener("click", () => dialog.close());
    });
    search?.addEventListener("input", updateResults);

    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        open();
      }
    });
  }
}

export function initialiseTabs(root = document) {
  for (const tablist of root.querySelectorAll("[data-tabs]")) {
    const tabs = [...tablist.querySelectorAll('[role="tab"]')];
    const selectTab = (selectedTab) => {
      for (const tab of tabs) {
        const selected = tab === selectedTab;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
        const panel = tab.ownerDocument.getElementById(tab.getAttribute("aria-controls"));
        if (panel) panel.hidden = !selected;
      }
    };

    for (const [index, tab] of tabs.entries()) {
      tab.addEventListener("click", () => selectTab(tab));
      tab.addEventListener("keydown", (event) => {
        const movement = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
        let nextIndex;
        if (event.key === "Home") nextIndex = 0;
        else if (event.key === "End") nextIndex = tabs.length - 1;
        else if (movement) nextIndex = (index + movement + tabs.length) % tabs.length;
        else return;
        event.preventDefault();
        tabs[nextIndex].focus();
        selectTab(tabs[nextIndex]);
      });
    }
  }
}

export function initialiseEvidenceLoopUi(root = document) {
  initialiseCommandPalettes(root);
  initialiseTabs(root);
}
