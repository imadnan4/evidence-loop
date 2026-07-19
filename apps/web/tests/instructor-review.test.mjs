import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { initialiseInstructorReview } from "../public/demo/assets/instructor-review.js";

class FakeElement {
  constructor({ dataset = {}, value = "" } = {}) {
    this.dataset = dataset;
    this.value = value;
    this.textContent = "";
    this.open = false;
    this.focusCount = 0;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, properties = {}) {
    let prevented = false;
    const event = {
      target: this,
      preventDefault() { prevented = true; },
      ...properties,
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return { prevented };
  }

  focus() {
    this.focusCount += 1;
    globalThis.document.activeElement = this;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
    this.dispatch("close");
  }
}

function createReviewHarness() {
  const sourceId = new FakeElement();
  const sourceContext = new FakeElement();
  const sourceExcerpt = new FakeElement();
  const closeButton = new FakeElement();
  const drawer = new FakeElement();
  drawer.querySelector = (selector) => ({
    "[data-source-id]": sourceId,
    "[data-source-context]": sourceContext,
    "[data-source-excerpt]": sourceExcerpt,
    "[data-source-close]": closeButton,
  })[selector] ?? null;

  const sourceControls = [
    "split-cell",
    "scaling-response",
    "baseline-cell",
    "baseline-response",
    "validation-cell",
    "validation-response",
    "validation-response",
  ].map((source) => new FakeElement({ dataset: { source } }));

  const actions = ["Reviewed", "Request follow-up", "Return for revision"].map((value, index) => {
    const action = new FakeElement({ value });
    action.checked = index === 0;
    return action;
  });
  const form = new FakeElement();
  form.querySelector = (selector) => selector === 'input[name="review-action"]:checked'
    ? actions.find((action) => action.checked) ?? null
    : null;
  const status = new FakeElement();

  const root = {
    querySelector(selector) {
      return {
        "#source-drawer": drawer,
        "[data-review-form]": form,
        "[data-review-status]": status,
      }[selector] ?? null;
    },
    querySelectorAll(selector) {
      return selector === "[data-source-drawer]" ? sourceControls : [];
    },
  };

  globalThis.document = { activeElement: null };
  initialiseInstructorReview(root);
  return { actions, closeButton, drawer, form, sourceContext, sourceControls, sourceExcerpt, sourceId, status };
}

const expectedSources = {
  "split-cell": ["artifact:sample-a-apartment-prices#cell-07", "train_test_split"],
  "scaling-response": ["response:sample-a:q1#00:34-00:46", "fit the scaler before splitting"],
  "baseline-cell": ["artifact:sample-a-apartment-prices#cell-11", "LinearRegression"],
  "baseline-response": ["response:sample-a:q2#01:12-01:25", "simple comparison"],
  "validation-cell": ["artifact:sample-a-apartment-prices#cell-14", "RandomForestRegressor"],
  "validation-response": ["response:sample-a:q3#02:08-02:21", "different parts of the training data"],
};

test("every provenance control opens the matching current-submission source", () => {
  const { drawer, sourceControls, sourceExcerpt, sourceId } = createReviewHarness();

  for (const control of sourceControls) {
    control.dispatch("click");
    const [expectedId, expectedExcerpt] = expectedSources[control.dataset.source];
    assert.equal(drawer.open, true);
    assert.equal(sourceId.textContent, expectedId);
    assert.match(sourceExcerpt.textContent, new RegExp(expectedExcerpt));
    drawer.close();
  }
});

test("source drawer close and Escape return focus to the source trigger", () => {
  const { closeButton, drawer, sourceControls } = createReviewHarness();
  const [firstControl, secondControl] = sourceControls;

  firstControl.dispatch("click");
  closeButton.dispatch("click");
  assert.equal(drawer.open, false);
  assert.equal(globalThis.document.activeElement, firstControl);

  secondControl.dispatch("click");
  const escape = drawer.dispatch("keydown", { key: "Escape" });
  assert.equal(escape.prevented, true);
  assert.equal(drawer.open, false);
  assert.equal(globalThis.document.activeElement, secondControl);
});

test("each human action reports an unsaved local synthetic-demo action", () => {
  const { actions, form, status } = createReviewHarness();

  for (const selected of actions) {
    for (const action of actions) action.checked = action === selected;
    const submission = form.dispatch("submit");
    assert.equal(submission.prevented, true);
    assert.equal(
      status.textContent,
      `Human review action selected for this synthetic demo: ${selected.value}. Nothing has been sent or saved.`,
    );
  }
});

test("review interaction script makes no network request or HTML injection sink", async () => {
  const script = await readFile(new URL("../public/demo/assets/instructor-review.js", import.meta.url), "utf8");
  assert.doesNotMatch(script, /\b(fetch|XMLHttpRequest)\s*\(/);
  assert.doesNotMatch(script, /\.innerHTML\b/);
  assert.match(script, /sourceExcerpt\.textContent/);
});
