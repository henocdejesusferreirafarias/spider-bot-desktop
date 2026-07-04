import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { ProxyChainService } from "../src/main/services/proxy-chain.js";

interface UpstreamHttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
}

interface UpstreamHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
}

async function withUpstreamHttp(
  handler: (req: UpstreamHttpRequest) => UpstreamHttpResponse
): Promise<{ port: number; close: () => Promise<void>; received: UpstreamHttpRequest[] }> {
  const received: UpstreamHttpRequest[] = [];
  const server = http.createServer((req, res) => {
    received.push({
      method: req.method ?? "GET",
      path: req.url ?? "/",
      headers: req.headers
    });
    const reply = handler({
      method: req.method ?? "GET",
      path: req.url ?? "/",
      headers: req.headers
    });
    res.writeHead(reply.status, reply.headers);
    res.end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("upstream http server failed to bind");
  }
  return {
    port: address.port,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  };
}

async function withUpstreamConnect(
  handler: (requestLine: string, headers: Record<string, string>) => {
    statusLine: string;
    rawPreData?: Buffer;
  }
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const headerText = buffer.subarray(0, headerEnd).toString("utf8");
      const [requestLine, ...rest] = headerText.split("\r\n");
      const headers: Record<string, string> = {};
      for (const line of rest) {
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        const name = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        headers[name] = value;
      }
      const reply = handler(requestLine ?? "", headers);
      let response = `${reply.statusLine}\r\n\r\n`;
      if (reply.rawPreData && reply.rawPreData.length > 0) {
        response = Buffer.concat([Buffer.from(response, "utf8"), reply.rawPreData]).toString(
          "binary"
        );
      }
      socket.write(response);
      socket.pause();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("upstream connect server failed to bind");
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  };
}

const USERNAME = "login__cr.us;sessid.11111111-2222-3333-4444-555555555555";
const PASSWORD = "p4ssw0rd!";
const EXPECTED_AUTH = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`;

async function requestThroughLocalProxy(
  chain: ProxyChainService,
  targetUrl: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
  } = {}
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  const target = new URL(targetUrl);
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: chain.localPort,
        method: options.method ?? "GET",
        path: targetUrl,
        headers: {
          Host: target.host,
          ...options.headers
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks)
          });
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.end();
  });
}

test("start binds a random local port and exposes it via localUrl", async () => {
  const upstream = await withUpstreamHttp(() => ({
    status: 200,
    headers: { "content-type": "text/plain" },
    body: "ok"
  }));
  const chain = new ProxyChainService({
    upstreamHost: "127.0.0.1",
    upstreamPort: upstream.port,
    username: USERNAME,
    password: PASSWORD
  });
  try {
    const port = await chain.start();
    assert.ok(port > 0);
    assert.equal(chain.localPort, port);
    assert.equal(chain.localUrl, `http://127.0.0.1:${port}`);
  } finally {
    await chain.stop();
    await upstream.close();
  }
});

test("stop is idempotent and resolves even when the server was never started", async () => {
  const chain = new ProxyChainService({
    upstreamHost: "127.0.0.1",
    upstreamPort: 1,
    username: "u",
    password: "p"
  });
  await chain.stop();
  await chain.stop();
});

test("forwards an HTTP GET to the upstream and injects Proxy-Authorization", async () => {
  const upstream = await withUpstreamHttp((req) => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: req.method, path: req.path, auth: req.headers["proxy-authorization"] })
  }));
  const chain = new ProxyChainService({
    upstreamHost: "127.0.0.1",
    upstreamPort: upstream.port,
    username: USERNAME,
    password: PASSWORD
  });
  try {
    await chain.start();
    const response = await requestThroughLocalProxy(chain, "http://example.test/api?x=1", {
      headers: { "x-trace": "abc" }
    });
    const body = JSON.parse(response.body.toString("utf8")) as {
      method: string;
      path: string;
      auth: string;
    };
    assert.equal(response.status, 200);
    assert.equal(body.method, "GET");
    assert.equal(body.path, "http://example.test/api?x=1");
    assert.equal(body.auth, EXPECTED_AUTH);
    assert.equal(upstream.received.length, 1);
    assert.equal(
      upstream.received[0]?.headers["x-trace"],
      "abc"
    );
    assert.equal(
      upstream.received[0]?.headers.host,
      "example.test"
    );
  } finally {
    await chain.stop();
    await upstream.close();
  }
});

test("strips a client-supplied Proxy-Authorization header so only the chain-injected one reaches the upstream", async () => {
  const upstream = await withUpstreamHttp((req) => ({
    status: 200,
    headers: { "content-type": "text/plain" },
    body: req.headers["proxy-authorization"] ?? "MISSING"
  }));
  const chain = new ProxyChainService({
    upstreamHost: "127.0.0.1",
    upstreamPort: upstream.port,
    username: USERNAME,
    password: PASSWORD
  });
  try {
    await chain.start();
    const response = await requestThroughLocalProxy(chain, "http://example.test/", {
      headers: {
        "Proxy-Authorization": "Basic SHOULD_BE_REPLACED"
      }
    });
    const body = response.body.toString("utf8");
    assert.equal(body, EXPECTED_AUTH);
    assert.notEqual(body, "Basic SHOULD_BE_REPLACED");
  } finally {
    await chain.stop();
    await upstream.close();
  }
});

test("preserves ;sessid. in the username when computing the upstream auth header", async () => {
  const upstream = await withUpstreamHttp((req) => ({
    status: 200,
    headers: { "content-type": "text/plain" },
    body: req.headers["proxy-authorization"] ?? ""
  }));
  const chain = new ProxyChainService({
    upstreamHost: "127.0.0.1",
    upstreamPort: upstream.port,
    username: USERNAME,
    password: PASSWORD
  });
  try {
    await chain.start();
    const response = await requestThroughLocalProxy(chain, "http://example.test/");
    const sent = response.body.toString("utf8");
    const decoded = Buffer.from(sent.replace(/^Basic /, ""), "base64").toString("utf8");
    assert.equal(decoded, `${USERNAME}:${PASSWORD}`);
    assert.match(decoded, /;sessid\./);
  } finally {
    await chain.stop();
    await upstream.close();
  }
});

test("forwards HTTP proxy requests without leaking client proxy auth headers", async () => {
  const upstream = await withUpstreamHttp((req) => ({
    status: 200,
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({
      seen: {
        connection: req.headers["connection"] ?? null,
        keepAlive: req.headers["keep-alive"] ?? null,
        upgrade: req.headers["upgrade"] ?? null,
        te: req.headers["te"] ?? null,
        proxyAuth: req.headers["proxy-authorization"] ?? null
      }
    })
  }));
  const chain = new ProxyChainService({
    upstreamHost: "127.0.0.1",
    upstreamPort: upstream.port,
    username: USERNAME,
    password: PASSWORD
  });
  try {
    await chain.start();
    const { status, headers, body: bodyBuffer } = await requestThroughLocalProxy(chain, "http://example.test/probe", {
      headers: {
        Connection: "keep-alive",
        "Keep-Alive": "timeout=5, max=1000",
        Upgrade: "h2c",
        TE: "trailers",
        "X-Safe": "kept"
      }
    });
    assert.equal(status, 200);
    assert.equal(headers.connection, "keep-alive");
    const body = JSON.parse(bodyBuffer.toString("utf8")) as { seen: Record<string, string | null> };
    assert.equal(body.seen.connection, "keep-alive");
    assert.equal(body.seen.keepAlive, null);
    assert.equal(body.seen.upgrade, null);
    assert.equal(body.seen.te, null);
    assert.equal(body.seen.proxyAuth, EXPECTED_AUTH);
    assert.equal(upstream.received[0]?.headers["x-safe"], "kept");
  } finally {
    await chain.stop();
    await upstream.close();
  }
});

test("forwards upstream HTTP response headers through the local proxy", async () => {
  const upstream = await withUpstreamHttp(() => ({
    status: 200,
    headers: {
      "content-type": "text/plain",
      "content-length": "2",
      connection: "keep-alive",
      "keep-alive": "timeout=5, max=1000",
      "alt-svc": 'h2=":443"; ma=86400',
      "x-safe": "kept"
    },
    body: "ok"
  }));
  const chain = new ProxyChainService({
    upstreamHost: "127.0.0.1",
    upstreamPort: upstream.port,
    username: USERNAME,
    password: PASSWORD
  });
  try {
    await chain.start();
    const response = await requestThroughLocalProxy(chain, "http://example.test/");
    assert.equal(response.status, 200);
    assert.equal(response.headers.connection, "keep-alive");
    assert.equal(response.headers["keep-alive"], "timeout=5");
    assert.equal(response.headers["alt-svc"], 'h2=":443"; ma=86400');
    assert.equal(response.headers["x-safe"], "kept");
  } finally {
    await chain.stop();
    await upstream.close();
  }
});

test("preserves Content-Encoding so the client can decode gzipped bodies", async () => {
  const { gzipSync } = await import("node:zlib");
  const payload = "hello from upstream ".repeat(50);
  const gzipped = gzipSync(Buffer.from(payload, "utf8"));
  const upstream = await withUpstreamHttp(() => ({
    status: 200,
    headers: {
      "content-type": "text/plain",
      "content-encoding": "gzip",
      "content-length": String(gzipped.length)
    },
    body: gzipped
  }));
  const chain = new ProxyChainService({
    upstreamHost: "127.0.0.1",
    upstreamPort: upstream.port,
    username: USERNAME,
    password: PASSWORD
  });
  try {
    await chain.start();
    const response = await requestThroughLocalProxy(chain, "http://example.test/");
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-encoding"], "gzip");
    const { gunzipSync } = await import("node:zlib");
    const decoded = gunzipSync(response.body).toString("utf8");
    assert.equal(decoded, payload);
  } finally {
    await chain.stop();
    await upstream.close();
  }
});

test("rejects malformed HTTP requests with 400", async () => {
  const upstream = await withUpstreamHttp(() => ({
    status: 200,
    headers: {},
    body: "should-not-be-hit"
  }));
  const chain = new ProxyChainService({
    upstreamHost: "127.0.0.1",
    upstreamPort: upstream.port,
    username: USERNAME,
    password: PASSWORD
  });
  try {
    await chain.start();
    const client = net.connect(chain.localPort, "127.0.0.1");
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    client.write("THIS IS NOT A VALID HTTP LINE\r\n\r\n");
    const reply = await new Promise<string>((resolve) => {
      client.once("data", (chunk) => resolve(chunk.toString("utf8")));
    });
    assert.match(reply, /400/);
    client.destroy();
    assert.equal(upstream.received.length, 0);
  } finally {
    await chain.stop();
    await upstream.close();
  }
});

test("forwards a CONNECT tunnel to the upstream with Proxy-Authorization and pipes payload", async () => {
  let upstreamSawAuth = false;
  const upstream = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let acknowledged = false;
    let target = "unknown";
    socket.on("data", (chunk) => {
      if (acknowledged) {
        socket.write(Buffer.from(`echo[${target}]:${chunk.toString("utf8")}`, "utf8"));
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const headerText = buffer.subarray(0, headerEnd).toString("utf8");
      const [requestLine, ...rest] = headerText.split("\r\n");
      const authLine = rest.find((l) => l.toLowerCase().startsWith("proxy-authorization:"));
      upstreamSawAuth = Boolean(authLine?.includes(EXPECTED_AUTH));
      target = (requestLine ?? "").split(" ")[1] ?? "unknown";
      socket.write(`HTTP/1.1 200 Connection Established\r\n\r\n`);
      acknowledged = true;
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const upstreamAddress = upstream.address();
  if (typeof upstreamAddress !== "object" || upstreamAddress === null) {
    throw new Error("upstream connect server failed to bind");
  }
  const chain = new ProxyChainService({
    upstreamHost: "127.0.0.1",
    upstreamPort: upstreamAddress.port,
    username: USERNAME,
    password: PASSWORD
  });
  try {
    await chain.start();
    const client = net.connect(chain.localPort, "127.0.0.1");
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    client.write("CONNECT example.com:8443 HTTP/1.1\r\nHost: example.com:8443\r\n\r\n");

    const headerReply = await new Promise<string>((resolve) => {
      client.once("data", (chunk) => resolve(chunk.toString("utf8")));
    });
    assert.match(headerReply, /HTTP\/1\.1 200 Connection Established/);

    const echoReply = await new Promise<string>((resolve) => {
      client.once("data", (chunk) => resolve(chunk.toString("utf8")));
      client.write("hello-after-connect");
    });
    assert.equal(echoReply, "echo[example.com:8443]:hello-after-connect");
    assert.equal(upstreamSawAuth, true);

    client.destroy();
  } finally {
    await chain.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("accepts HTTP/1.0 2xx CONNECT responses from upstream proxies", async () => {
  const upstream = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let acknowledged = false;
    socket.on("data", (chunk) => {
      if (acknowledged) {
        socket.write(Buffer.from(`tunnel:${chunk.toString("utf8")}`, "utf8"));
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      socket.write("HTTP/1.0 200 Connection established\r\nProxy-Agent: test\r\n\r\n");
      acknowledged = true;
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const upstreamAddress = upstream.address();
  if (typeof upstreamAddress !== "object" || upstreamAddress === null) {
    throw new Error("upstream connect server failed to bind");
  }
  const chain = new ProxyChainService({
    upstreamHost: "127.0.0.1",
    upstreamPort: upstreamAddress.port,
    username: USERNAME,
    password: PASSWORD
  });
  try {
    await chain.start();
    const client = net.connect(chain.localPort, "127.0.0.1");
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    client.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");

    const headerReply = await new Promise<string>((resolve) => {
      client.once("data", (chunk) => resolve(chunk.toString("utf8")));
    });
    assert.match(headerReply, /HTTP\/1\.1 200 Connection Established/);

    const tunnelReply = await new Promise<string>((resolve) => {
      client.once("data", (chunk) => resolve(chunk.toString("utf8")));
      client.write("ping");
    });
    assert.equal(tunnelReply, "tunnel:ping");
    client.destroy();
  } finally {
    await chain.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("translates CONNECT auth failures so the browser never sees Proxy-Authenticate", async () => {
  const upstream = await withUpstreamConnect(() => ({
    statusLine: "HTTP/1.1 407 Proxy Authentication Required",
    rawPreData: Buffer.from("auth failed", "utf8")
  }));
  const chain = new ProxyChainService({
    upstreamHost: "127.0.0.1",
    upstreamPort: upstream.port,
    username: USERNAME,
    password: PASSWORD
  });
  try {
    await chain.start();
    const client = net.connect(chain.localPort, "127.0.0.1");
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    client.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");

    const reply = await new Promise<string>((resolve) => {
      client.once("data", (chunk) => resolve(chunk.toString("utf8")));
    });
    assert.match(reply, /^HTTP\/1\.1 597 UPSTREAM407\r\n/);
    assert.doesNotMatch(reply, /Proxy-Authenticate/i);
    client.destroy();
  } finally {
    await chain.stop();
    await upstream.close();
  }
});

test("stop terminates open client sockets", async () => {
  const upstream = await withUpstreamHttp(() => ({
    status: 200,
    headers: {},
    body: "ok"
  }));
  const chain = new ProxyChainService({
    upstreamHost: "127.0.0.1",
    upstreamPort: upstream.port,
    username: USERNAME,
    password: PASSWORD
  });
  await chain.start();
  const client = net.connect(chain.localPort, "127.0.0.1");
  await new Promise<void>((resolve) => client.once("connect", () => resolve()));
  const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
  await chain.stop();
  await closed;
  assert.equal(client.destroyed, true);
  await upstream.close();
});
