const sources = {
  "split-cell": {
    id: "artifact:sample-a-apartment-prices#cell-07",
    context: "Notebook code cell 07 · submitted artifact",
    excerpt: "X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2)\nscaler.fit(X_train)\nX_train_scaled = scaler.transform(X_train)\nX_test_scaled = scaler.transform(X_test)",
  },
  "scaling-response": {
    id: "response:sample-a:q1#00:34-00:46",
    context: "Typed response to question 1 · canonical response record",
    excerpt: "If I fit the scaler before splitting, it sees the test values too. I split first so the test set stays unseen until we evaluate.",
  },
  "baseline-cell": {
    id: "artifact:sample-a-apartment-prices#cell-11",
    context: "Notebook code cell 11 · submitted artifact",
    excerpt: "baseline = LinearRegression()\nbaseline.fit(X_train_scaled, y_train)\nprint(mean_absolute_error(y_test, baseline.predict(X_test_scaled)))",
  },
  "baseline-response": {
    id: "response:sample-a:q2#01:12-01:25",
    context: "Typed response to question 2 · canonical response record",
    excerpt: "I started with linear regression because it gives me a simple comparison. Then I can tell whether a more complex model is actually helping.",
  },
  "validation-cell": {
    id: "artifact:sample-a-apartment-prices#cell-14",
    context: "Notebook code cell 14 · submitted artifact",
    excerpt: "model = RandomForestRegressor(random_state=7)\nmodel.fit(X_train_scaled, y_train)\nfinal_mae = mean_absolute_error(y_test, model.predict(X_test_scaled))",
  },
  "validation-response": {
    id: "response:sample-a:q3#02:08-02:21",
    context: "Typed response to question 3 · canonical response record",
    excerpt: "Cross-validation would help check the model on different parts of the training data. I would use the test set at the end.",
  },
};

export function initialiseInstructorReview(root = document) {
  const drawer = root.querySelector("#source-drawer");
  const sourceId = drawer?.querySelector("[data-source-id]");
  const sourceContext = drawer?.querySelector("[data-source-context]");
  const sourceExcerpt = drawer?.querySelector("[data-source-excerpt]");
  const closeButton = drawer?.querySelector("[data-source-close]");
  let sourceTrigger = null;

  const closeDrawer = () => {
    if (drawer?.open) drawer.close();
    sourceTrigger?.focus();
  };

  root.querySelectorAll("[data-source-drawer]").forEach((button) => {
    button.addEventListener("click", () => {
      const source = sources[button.dataset.source];
      if (!source || !drawer || typeof drawer.showModal !== "function") return;
      sourceTrigger = button;
      if (sourceId) sourceId.textContent = source.id;
      if (sourceContext) sourceContext.textContent = source.context;
      if (sourceExcerpt) sourceExcerpt.textContent = source.excerpt;
      if (!drawer.open) drawer.showModal();
      closeButton?.focus();
    });
  });

  closeButton?.addEventListener("click", closeDrawer);
  drawer?.addEventListener("click", (event) => {
    if (event.target === drawer) closeDrawer();
  });
  drawer?.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && drawer.open) {
      event.preventDefault();
      closeDrawer();
    }
  });
  drawer?.addEventListener("close", () => {
    if (document.activeElement !== sourceTrigger) sourceTrigger?.focus();
  });

  const form = root.querySelector("[data-review-form]");
  const status = root.querySelector("[data-review-status]");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const action = form.querySelector('input[name="review-action"]:checked')?.value;
    if (status && action) status.textContent = `Human review action selected for this synthetic demo: ${action}. Nothing has been sent or saved.`;
  });
}
