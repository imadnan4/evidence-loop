# Evidence Loop UI

Framework-neutral presentation primitives for the Evidence Loop web experience.

## Use

Load `src/primitives.css` (which imports the tokens) and use the documented `el-*` classes with semantic HTML. Load `src/components.js` only for optional command-palette enhancement. The module makes no network requests and owns no assessment state.

- Use `el-card--flat`, `el-card--slight`, `el-card--raised`, and `el-dialog` for the four material tiers.
- Use native `<button>`, `<label>`, `<input>`, `<dialog>`, and `<details>` before adding ARIA.
- Keep the visible `:focus-visible` treatment and `prefers-reduced-motion` rule intact.
- Use amber only with an explicit “Needs review” label, and reserve red for destructive or error states.

Open `stories/index.html` in a browser to inspect the primitive reference.
