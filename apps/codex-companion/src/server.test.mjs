import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createCompanionServer } from "./server.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("companion handles API preflight locally for every write method", async (context) => {
  let upstreamRequests = 0;
  const upstream = createServer((_request, response) => {
    upstreamRequests += 1;
    response.writeHead(500).end();
  });
  const upstreamOrigin = await listen(upstream);
  const companion = createCompanionServer({ apiOrigin: upstreamOrigin });
  const companionOrigin = await listen(companion);
  context.after(async () => {
    await close(companion);
    await close(upstream);
  });

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await fetch(`${companionOrigin}/api/example`, {
      method: "OPTIONS",
      headers: {
        Origin: "null",
        "Access-Control-Request-Method": method,
        "Access-Control-Request-Headers": "content-type,x-autofix-test",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.match(response.headers.get("access-control-allow-methods") || "", new RegExp(`(^|,)${method}(,|$)`));
    assert.equal(response.headers.get("access-control-allow-headers"), "content-type,x-autofix-test");
    assert.equal(response.headers.get("access-control-allow-private-network"), "true");
  }
  assert.equal(upstreamRequests, 0);
});

test("companion proxies JSON POST and owns the downstream CORS headers", async (context) => {
  const upstream = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    response.writeHead(201, {
      "Access-Control-Allow-Origin": "http://unexpected.example",
      "Content-Type": "application/json",
    });
    response.end(JSON.stringify({ method: request.method, body }));
  });
  const upstreamOrigin = await listen(upstream);
  const companion = createCompanionServer({ apiOrigin: upstreamOrigin });
  const companionOrigin = await listen(companion);
  context.after(async () => {
    await close(companion);
    await close(upstream);
  });

  const response = await fetch(`${companionOrigin}/api/example`, {
    method: "POST",
    headers: { Origin: "null", "Content-Type": "application/json" },
    body: JSON.stringify({ title: "diagnostic" }),
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await response.json(), {
    method: "POST",
    body: JSON.stringify({ title: "diagnostic" }),
  });
});
