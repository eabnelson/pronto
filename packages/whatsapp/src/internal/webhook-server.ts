import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const WEBHOOK_PATH = "/whatsapp";
const MAX_BODY_BYTES = 1024 * 1024;

export interface WebhookServer {
  close(): Promise<void>;
  readonly secret: string;
  readonly url: string;
}

/** Loopback-only receiver for `wacli sync --webhook`, verifying `X-Wacli-Signature`. */
export async function startWebhookServer(onPayload: (payload: unknown) => void): Promise<WebhookServer> {
  const secret = randomBytes(32).toString("base64url");
  const server = createServer((request, response) => {
    handle(request, response, secret, onPayload);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    close: () => closeServer(server),
    secret,
    url: `http://127.0.0.1:${address.port}${WEBHOOK_PATH}`,
  };
}

function handle(
  request: IncomingMessage,
  response: ServerResponse,
  secret: string,
  onPayload: (payload: unknown) => void,
): void {
  if (request.url !== WEBHOOK_PATH) return finish(response, 404);
  if (request.method !== "POST") return finish(response, 405);
  const declared = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return finish(response, 413, true);
  const chunks: Buffer[] = [];
  let size = 0;
  let rejected = false;
  request.on("data", (chunk: Buffer) => {
    if (rejected) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      rejected = true;
      finish(response, 413, true);
      return;
    }
    chunks.push(chunk);
  });
  request.on("error", () => {
    rejected = true;
  });
  request.on("end", () => {
    if (rejected) return;
    const body = Buffer.concat(chunks);
    if (!validSignature(secret, body, request.headers["x-wacli-signature"])) {
      return finish(response, 401);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      return finish(response, 400);
    }
    finish(response, 204);
    onPayload(payload);
  });
}

function validSignature(secret: string, body: Buffer, header: string | string[] | undefined): boolean {
  if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const actual = Buffer.from(header.slice("sha256=".length).trim().toLowerCase(), "utf8");
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("hex"), "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function finish(response: ServerResponse, status: number, closeConnection = false): void {
  if (response.headersSent) return;
  if (closeConnection) response.setHeader("Connection", "close");
  response.statusCode = status;
  response.end();
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
