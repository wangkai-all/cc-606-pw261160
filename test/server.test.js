import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../server.js";
import { WINDOW } from "./helpers.js";

async function withServer(fn) {
  const { createServer, service } = createApp();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base, service);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function getJson(url, init) {
  const res = await fetch(url, init);
  const body = await res.json();
  return { status: res.status, body, headers: res.headers };
}

function post(url, payload) {
  return getJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

test("GET /api/analysis 返回完整业务结果与证据摘要", async () => {
  await withServer(async (base) => {
    const { status, body } = await getJson(`${base}/api/analysis`);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.action, "analysis");
    assert.equal(body.summary.sessionCount, 9);
    assert.equal(body.summary.stallNights, 62);
    assert.ok(body.summary.availableHours > 0);
    assert.equal(body.rows.length, 62);
    assert.ok(body.evidence.digest.startsWith("ANALYSIS|"));
    assert.equal(body.evidence.strategy, "interval-intersection");
    // 跨零点营业日只有一个条目
    const crossNights = body.nights.filter((n) => n.crossesMidnight);
    assert.deepEqual(
      crossNights.map((n) => n.nightKey),
      ["2026-11-19", "2026-11-20", "2026-11-21"],
    );
    assert.equal(new Set(body.nights.map((n) => n.nightKey)).size, body.nights.length);
  });
});

test("GET /api/availability 返回可用时段分母与逐班次分段", async () => {
  await withServer(async (base) => {
    const { body } = await getJson(`${base}/api/availability`);
    assert.equal(body.ok, true);
    assert.equal(body.action, "availability");
    assert.ok(body.summary.definition.includes("区间"));
    const row = body.rows.find((r) => r.stallId === "S-A03" && r.nightKey === "2026-11-19");
    assert.equal(row.segments.length, 2);
    assert.equal(row.availableMinutes, 180);
    assert.equal(row.closedMinutes, 120);
    assert.ok(body.evidence.digest.startsWith("AVAILABILITY|"));
  });
});

test("POST /api/closures/backfill 修订分母并回查票面", async () => {
  await withServer(async (base) => {
    const before = await getJson(`${base}/api/availability`);
    const { status, body } = await post(`${base}/api/closures/backfill`, {
      scope: "stall",
      stallId: "S-A01",
      nightKey: "2026-11-19",
      startClock: "20:00",
      endClock: "21:00",
      reason: "燃气灶具临时故障",
    });
    assert.equal(status, 201);
    assert.equal(body.action, "backfill");
    assert.equal(body.closure.id, "CL-B01");
    assert.equal(body.impact.availabilityDelta[0].lostMinutes, 60);
    assert.equal(body.impact.ticketAttributionStable, true);
    assert.ok(body.evidence.digest.startsWith("ANALYSIS|"));
    assert.notEqual(body.beforeDigest, body.afterDigest);

    const after = await getJson(`${base}/api/availability`);
    assert.equal(
      after.body.summary.availableHours,
      round(before.body.summary.availableHours - 1),
    );
  });
});

test("POST /api/closures/backfill 校验失败时返回 422 且不改动状态", async () => {
  await withServer(async (base) => {
    const before = await getJson(`${base}/api/analysis`);
    const { status, body } = await post(`${base}/api/closures/backfill`, {
      scope: "stall",
      stallId: "S-A01",
      nightKey: "2026-11-19",
      startClock: "21:00",
      endClock: "21:00",
      reason: "",
    });
    assert.equal(status, 422);
    assert.equal(body.ok, false);
    const codes = body.problems.map((p) => p.code);
    assert.ok(codes.includes("empty-closure-window"));
    assert.ok(codes.includes("missing-reason"));
    const after = await getJson(`${base}/api/analysis`);
    assert.equal(after.body.evidence.digest, before.body.evidence.digest);
  });
});

test("未知接口与非 JSON 请求体给出明确错误", async () => {
  await withServer(async (base) => {
    const missing = await getJson(`${base}/api/nope`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.ok, false);

    const bad = await getJson(`${base}/api/closures/backfill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /JSON/);
  });
});

test("页面与静态资源可访问，且包含 data-evidence-result 钩子", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /data-evidence-result/);
    assert.match(html, /运行原营业分析/);
    assert.match(html, /补交临时停业/);
    assert.match(html, /查看可用时段分母/);
    const css = await fetch(`${base}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /text\/css/);
    const js = await fetch(`${base}/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type"), /javascript/);
  });
});

test("路径穿越被拒绝", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/..%2f..%2fpackage.json`);
    assert.notEqual(res.status, 200);
  });
});

test("分析窗口可经查询参数收窄", async () => {
  await withServer(async (base) => {
    const { body } = await getJson(`${base}/api/analysis?from=${WINDOW.from}&to=2026-11-18`);
    assert.equal(body.summary.sessionCount, 2);
    assert.equal(body.summary.from, WINDOW.from);
    assert.equal(body.summary.to, "2026-11-18");
  });
});

function round(n) {
  return Math.round(n * 100) / 100;
}
