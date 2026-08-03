import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

function json(response, data, status = 200) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(data));
}

export function createDashboardServer({ store, host = "127.0.0.1", port = 4317, getStatus = () => ({}) }) {
  const clients = new Set();
  const onCall = (call) => {
    const message = `event: call\ndata: ${JSON.stringify(call)}\n\n`;
    for (const client of clients) client.write(message);
  };
  store.on("call", onCall);

  const server = createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
    if (url.pathname === "/api/health") return json(response, { ok: true, ...getStatus() });
    if (url.pathname === "/api/summary") return json(response, store.summary());
    if (url.pathname === "/api/calls") {
      const rows = store.recent(Number(url.searchParams.get("limit") || 100)).map((row) => ({
        id: row.id,
        observed_at: row.observed_at,
        source: row.source,
        model: row.model,
        prompt_tokens: row.prompt_tokens,
        completion_tokens: row.completion_tokens,
        total_tokens: row.total_tokens,
        cached_tokens: row.cached_tokens,
        cache_write_tokens: row.cache_write_tokens,
        credits: row.credits,
        credit_kind: row.credit_kind,
        multiplier: row.multiplier
      }));
      return json(response, rows);
    }
    if (url.pathname === "/api/export.csv") {
      response.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="trae-usage-${new Date().toISOString().slice(0, 10)}.csv"`
      });
      return response.end(store.csv());
    }
    if (url.pathname === "/api/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      response.write(`event: status\ndata: ${JSON.stringify(getStatus())}\n\n`);
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }

    const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (!/^[\w.-]+$/u.test(relative)) return json(response, { error: "Not found" }, 404);
    const path = join(publicDir, relative);
    try {
      const stat = readFileSync(path);
      response.writeHead(200, {
        "content-type": types[extname(path)] || "application/octet-stream",
        "cache-control": "no-store"
      });
      response.end(stat);
    } catch { json(response, { error: "Not found" }, 404); }
  });

  return {
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      return `http://${host}:${actualPort}`;
    },
    close() {
      store.off("call", onCall);
      for (const client of clients) client.end();
      clients.clear();
      return new Promise((resolve) => server.close(resolve));
    }
  };
}
