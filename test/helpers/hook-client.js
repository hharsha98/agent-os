// A small HTTP client for the hook endpoint tests (SP4, Task X2a). Not a test
// file: the runner only runs test/*.test.js. It posts the way Claude Code's
// "type": "http" hooks do (POST, a JSON body, "Authorization: Bearer
// <token>"), over a keep-alive connection so a test can tell a normal answer
// from one that closes the connection, and it times the answer.
import http from "node:http";

// postHook(options) → { status, body, headers, ms }.
//   body          sent as JSON (default {}); rawBytes (a string or Buffer) is sent as it is instead
//   path          added after /hooks/sessions/<sessionId> (for example "/status"); urlPath replaces the whole path
//   token         sends "Authorization: Bearer <token>"; authorization sends that exact header value instead
//   host          the Host header (default: Node's own, 127.0.0.1:<port>)
//   chunked       sends the body in 16 KB pieces without a Content-Length
export function postHook({
  port,
  sessionId,
  token,
  authorization,
  body,
  rawBytes,
  path: suffix = "",
  urlPath,
  host,
  chunked = false,
  method = "POST",
  timeoutMs = 10000
} = {}) {
  const payload = rawBytes !== undefined ? Buffer.from(rawBytes) : Buffer.from(JSON.stringify(body ?? {}), "utf8");
  const headers = { "Content-Type": "application/json" };
  if (!chunked) headers["Content-Length"] = String(payload.length);
  if (host !== undefined) headers.Host = host;
  if (authorization !== undefined) headers.Authorization = authorization;
  else if (token !== undefined && token !== null) headers.Authorization = `Bearer ${token}`;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const started = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      agent.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const request = http.request(
      { host: "127.0.0.1", port, method, path: urlPath ?? `/hooks/sessions/${sessionId}${suffix}`, headers, agent },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          finish(null, {
            status: response.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            ms: Number(process.hrtime.bigint() - started) / 1e6
          })
        );
        response.on("error", (error) => finish(error));
      }
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`postHook: no answer within ${timeoutMs} ms`)));
    request.on("error", (error) => finish(error));
    if (chunked) {
      for (let at = 0; at < payload.length; at += 16 * 1024) request.write(payload.subarray(at, at + 16 * 1024));
      request.end();
    } else {
      request.end(payload);
    }
  });
}
