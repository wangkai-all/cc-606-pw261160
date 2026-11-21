/**
 * HTTP server. Node built-ins only. Binds 127.0.0.1 and honours PORT.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Service, readTransactions } from "./lib/service.js";
import { loadRegister } from "./lib/venue.js";
import {
  serialiseAnalysis,
  serialiseAvailability,
  sessionsPayload,
} from "./lib/report.js";
import { ValidationError } from "./lib/validate.js";
import { validateWindow } from "./lib/validate.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const MAX_BODY = 256 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function createApp({ dataDir = DATA_DIR } = {}) {
  const transactionsRaw = readJsonFile(path.join(dataDir, "transactions.json"));
  const transactions = readTransactions(transactionsRaw);
  const service = new Service({
    venue: loadRegister(path.join(dataDir, "venue.json")),
    transactions,
  });

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw Object.assign(new Error("请求体过大"), { statusCode: 413 });
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    const text = Buffer.concat(chunks).toString("utf8");
    try {
      return JSON.parse(text);
    } catch {
      throw Object.assign(new Error("请求体不是合法 JSON"), { statusCode: 400 });
    }
  }

  function createServer() {
    return http.createServer(async (req, res) => {
      try {
        await route(req, res);
      } catch (err) {
        sendError(res, err);
      }
    });
  }

  async function route(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith("/api/")) return api(req, res, url, pathname);

    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { ok: false, error: "只支持 GET" });
    }
    return serveStatic(res, pathname);
  }

  async function api(req, res, url, pathname) {
    if (pathname === "/api/state" && req.method === "GET") {
      const window = validateWindow(readWindowQuery(url, service));
      const analysis = service.runAnalysis(window);
      return sendJson(res, 200, {
        ...service.state(),
        window,
        sessions: analysis.sessions.map((s) => ({
          nightKey: s.nightKey,
          weekday: s.weekday,
          weekdayLabel: s.weekdayLabel,
          crossesMidnight: s.crossesMidnight,
          open: s.registeredOpen,
          close: s.registeredClose,
          overrideReason: s.overrideReason,
        })),
        counts: {
          sessions: analysis.sessions.length,
          rows: analysis.rows.filter((r) => r.scheduled).length,
          closures: analysis.closures.all.length,
        },
      });
    }

    if (pathname === "/api/analysis" && (req.method === "GET" || req.method === "POST")) {
      const body = req.method === "POST" ? await readBody(req) : {};
      const window = validateWindow(readWindowQuery(url, service, body));
      const analysis = service.runAnalysis(window);
      return sendJson(res, 200, serialiseAnalysis(analysis, service.venue, { window }));
    }

    if (pathname === "/api/availability" && (req.method === "GET" || req.method === "POST")) {
      const body = req.method === "POST" ? await readBody(req) : {};
      const window = validateWindow(readWindowQuery(url, service, body));
      const analysis = service.runAnalysis(window);
      return sendJson(res, 200, serialiseAvailability(analysis, service.venue, { window }));
    }

    if (pathname === "/api/closures/backfill" && req.method === "POST") {
      const body = await readBody(req);
      const window = validateWindow(readWindowQuery(url, service, body));
      const result = service.backfillClosure(window, body);
      const payload = serialiseBackfill(result, service, window);
      return sendJson(res, 201, payload);
    }

    if (pathname === "/api/sessions" && req.method === "GET") {
      const window = validateWindow(readWindowQuery(url, service));
      const analysis = service.runAnalysis(window);
      return sendJson(res, 200, { ok: true, ...sessionsPayload(analysis) });
    }

    return sendJson(res, 404, { ok: false, error: `未知接口：${pathname}` });
  }

  function serveStatic(res, pathname) {
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== path.join(PUBLIC_DIR, "index.html")) {
      return sendJson(res, 403, { ok: false, error: "禁止访问" });
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        if (err.code === "ENOENT") return sendJson(res, 404, { ok: false, error: "页面不存在" });
        return sendError(res, err);
      }
      res.writeHead(200, {
        "content-type": MIME[path.extname(file)] || "application/octet-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(data);
    });
  }

  return { createServer, service };
}

function readWindowQuery(url, service, body = {}) {
  const from = body.from || url.searchParams.get("from") || service.state().defaultWindow.from;
  const to = body.to || url.searchParams.get("to") || service.state().defaultWindow.to;
  return { from, to };
}

function serialiseBackfill(result, service, window) {
  const { impact, analysis } = result;
  const rows = analysis.rows
    .filter((row) => closureRelevant(row, result.normalised))
    .map((row) => ({
      stallId: row.stall.id,
      stallName: row.stall.name,
      nightKey: row.session.nightKey,
      weekdayLabel: row.session.weekdayLabel,
      sessionRange: `${row.session.nightKey} ${row.session.weekdayLabel}`,
      availableMinutes: Math.round(row.availableSeconds / 60),
      rawMinutes: Math.round((row.rawSeconds || 0) / 60),
      closedMinutes: Math.round(((row.rawSeconds || 0) - row.availableSeconds) / 60),
      closures: row.contributors.map((c) => ({
        id: c.id,
        kind: c.kind,
        reason: c.reason,
        minutes: Math.round(c.cutSeconds / 60),
      })),
      tickets: row.tickets.map((t) => ({
        id: t.id,
        label: t.label,
        amount: t.amount,
        basis: t.basis,
        inAvailable: t.inAvailable,
        insideClosure: t.insideClosure,
      })),
    }));

  return {
    ok: true,
    action: "backfill",
    window: { from: window.from, to: window.to },
    closure: {
      id: result.closure.id,
      kind: result.closure.kind,
      scope: result.closure.scope,
      stallId: result.normalised.stallId,
      areaId: result.normalised.areaId,
      nightKey: result.normalised.nightKey,
      windowLabel: `${result.normalised.startLabel} – ${result.normalised.endLabel}`,
      minutes: Math.round((result.normalised.end - result.normalised.start) / 60),
      reason: result.normalised.reason,
      source: result.closure.source,
      supersedes: result.closure.supersedes,
    },
    impact: {
      revision: impact.revision,
      nightKey: impact.nightKey,
      session: impact.session,
      ticketCount: impact.ticketCount,
      ticketAttributionStable: impact.ticketAttributionStable,
      affectedStalls: impact.affectedStalls,
      availabilityDelta: impact.availabilityDelta,
      overlappingClosures: impact.overlappingClosures,
      superseded: impact.superseded,
      tickets: impact.tickets,
    },
    beforeDigest: result.beforeDigest,
    afterDigest: result.afterDigest,
    rows,
    evidence: {
      digest: result.afterDigest,
      generatedAt: new Date().toISOString(),
      strategy: "interval-intersection",
      revision: result.closure.id,
      rowsRecomputed: analysis.rows.length,
    },
  };
}

function closureRelevant(row, closure) {
  if (row.session.nightKey !== closure.nightKey) return false;
  if (closure.scope === "venue") return true;
  if (closure.scope === "area") return row.stall.areaId === closure.areaId;
  return row.stall.id === closure.stallId;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function sendError(res, err) {
  if (err instanceof ValidationError) {
    return sendJson(res, err.statusCode || 422, {
      ok: false,
      action: "error",
      error: err.message,
      problems: err.problems,
    });
  }
  const status = err.statusCode || 500;
  if (status >= 500) console.error(err);
  return sendJson(res, status, { ok: false, action: "error", error: err.message || "服务内部错误" });
}

/* ---- entry point ---------------------------------------------------------- */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`PORT 非法：${process.env.PORT}`);
    process.exit(1);
  }
  const { createServer } = createApp();
  const server = createServer();
  server.listen(port, "127.0.0.1", () => {
    const actual = server.address().port;
    console.log(`青禾夜市摊位利用率分析台：http://127.0.0.1:${actual}/`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
