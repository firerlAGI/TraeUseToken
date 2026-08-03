#!/usr/bin/env node
import { CdpConnection } from "../src/cdp.mjs";

const port = Number(process.argv[2] || 9222);
const expectedText = process.argv[3] || "0.04";
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const page = targets.find((target) => target.type === "page" && target.url?.includes("workbench.html"));
if (!page) throw new Error("TRAE workbench target not found");
const cdp = await new CdpConnection(page.webSocketDebuggerUrl).connect();
await cdp.send("Runtime.enable");

const expression = `(${function inspect(text) {
  const simplify = (value, depth = 0, seen = new WeakSet()) => {
    if (value === null || value === undefined || ["string", "number", "boolean"].includes(typeof value)) return value;
    if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
    if (typeof value !== "object" || depth > 4 || seen.has(value)) return String(value);
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 8).map((item) => simplify(item, depth + 1, seen));
    const result = {};
    for (const key of Object.keys(value).slice(0, 100)) {
      if (depth > 1 && !/(?:fee|usage|credit|cost|token|model|message|value|type|input|output|total)/iu.test(key)) continue;
      try { result[key] = simplify(value[key], depth + 1, seen); } catch { /* Ignore getters. */ }
    }
    return result;
  };
  const leaves = [...document.querySelectorAll("*")].filter((element) =>
    element.children.length === 0 && element.textContent?.trim() === text);
  return leaves.map((leaf) => {
    const ancestors = [];
    for (let element = leaf, level = 0; element && level < 10; element = element.parentElement, level++) {
      const propKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
      const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
      const fibers = [];
      let fiber = fiberKey ? element[fiberKey] : null;
      for (let index = 0; fiber && index < 8; fiber = fiber.return, index++) {
        const name = typeof fiber.type === "function" ? fiber.type.name : fiber.elementType?.name || fiber.type;
        fibers.push({ name: name ? String(name) : null, memoizedProps: simplify(fiber.memoizedProps) });
      }
      ancestors.push({ tag: element.tagName, className: typeof element.className === "string" ? element.className : String(element.className),
        props: propKey ? simplify(element[propKey]) : null, fibers });
    }
    return { text: leaf.textContent?.trim(), outerHTML: leaf.outerHTML.slice(0, 1000), ancestors };
  });
}})(${JSON.stringify(expectedText)})`;

const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(result.result?.value ?? { error: result.result?.description }, null, 2));
cdp.close();
