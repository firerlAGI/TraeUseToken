import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const publicDashboard = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const extensionDashboard = readFileSync(new URL("../extension/extension.cjs", import.meta.url), "utf8");

for (const [name, source] of [["public dashboard", publicDashboard], ["TRAE webview", extensionDashboard]]) {
  test(`${name} constrains and labels the records scroller`, () => {
    assert.match(source, /max-height:clamp\(320px,52vh,560px\)/u);
    assert.match(source, /overflow:auto/u);
    assert.match(source, /position:sticky/u);
    assert.match(source, /aria-label="调用记录，可滚动"/u);
    assert.match(source, /tabindex="0"/u);
  });
}
