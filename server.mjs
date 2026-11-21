import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify as mockClassify } from "./mock-ai.mjs";
import { triage, INVALID_INPUT } from "./triage.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));
const MAX_BODY_BYTES = 64 * 1024;

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createTriageServer({ classify = mockClassify, timeoutMs } = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      const raw = await readBody(request);
      if (raw === null) return json(response, 400, INVALID_INPUT);
      const { httpStatus, body, reason } = await triage(raw, { classify, timeoutMs });
      if (body.status === "manual_review") console.warn(`[triage] manual_review: ${reason}`);
      return json(response, httpStatus, body);
    } catch (error) {
      console.error("[triage] unexpected error", error);
      json(response, 500, { status: "server_error" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  createTriageServer().listen(port, "127.0.0.1", () => {
    console.log(`Listening on http://127.0.0.1:${port}`);
  });
}
