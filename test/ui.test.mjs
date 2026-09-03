import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const publicDashboard = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const extensionDashboard = readFileSync(new URL("../extension/extension.cjs", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("uses the Trae Use Token brand in the manifest and dashboards", () => {
  assert.equal(manifest.displayName, "Trae Use Token");
  assert.equal(manifest.publisher, "firerl");
  assert.equal(manifest.repository.url, "https://github.com/firerlAGI/TraeUseToken.git");
  assert.match(publicDashboard, /<h1>Trae Use Token<\/h1>/u);
  assert.match(extensionDashboard, /<h1>Trae Use Token<\/h1>/u);
});

for (const [name, source] of [["public dashboard", publicDashboard], ["TRAE webview", extensionDashboard]]) {
  test(`${name} constrains and labels the records scroller`, () => {
    assert.match(source, /max-height:clamp\(320px,52vh,560px\)/u);
    assert.match(source, /overflow:auto/u);
    assert.match(source, /position:sticky/u);
    assert.match(source, /aria-label="调用记录，可滚动"/u);
    assert.match(source, /tabindex="0"/u);
  });

  test(`${name} presents credit-free Coding Plan calls as not applicable`, () => {
    assert.match(source, /不适用/u);
    assert.match(source, /免重启调用监听已就绪/u);
  });
}
