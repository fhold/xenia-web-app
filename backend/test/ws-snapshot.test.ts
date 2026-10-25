/**
 * Review H-6 — the connect snapshot must carry a running shot.
 *
 * The hub replayed live frame, setpoints and maintenance to a new client, but
 * not the active shot. After a reload / PWA restart / second device mid-brew the
 * client had `activeShot === null` — no chart context and, above all, no Stop
 * button. The maintenance banner had the same replay for the same reason.
 *
 * Runs the real upgrade path: an http server, the hub attached to it, and a real
 * ws client. No machine, no DB.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { WsHub } from "../src/ws/broadcast.js";
import type { Shot, WsMessage } from "../../shared/src/types.js";

const logger = {
  child: () => logger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

function shot(id: number): Shot {
  return { id, startedAt: Date.now() } as Shot;
}

/** Starts a hub on a throwaway http server; returns its /ws url and a stop(). */
async function startHub(): Promise<{ hub: WsHub; url: string; stop: () => void }> {
  const hub = new WsHub(logger as never, { previous: () => null } as never);
  const server = http.createServer();
  hub.attach({ server } as never, new EventEmitter() as never);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { hub, url: `ws://127.0.0.1:${port}/ws`, stop: () => server.close() };
}

/** Everything the server pushes unprompted after connecting. */
async function snapshot(url: string): Promise<WsMessage[]> {
  const ws = new WebSocket(url);
  const msgs: WsMessage[] = [];
  ws.on("message", (raw: Buffer) => msgs.push(JSON.parse(raw.toString()) as WsMessage));
  await new Promise((r) => ws.on("open", r));
  await new Promise((r) => setTimeout(r, 50));
  ws.close();
  return msgs;
}

test("H-6: a client connecting mid-brew is told about the running shot", async () => {
  const { hub, url, stop } = await startHub();
  hub.broadcastShotStarted(shot(42));

  const msgs = await snapshot(url);
  stop();

  const started = msgs.find((m) => m.type === "shotStarted");
  assert.ok(started, "no shotStarted in the snapshot — the client has no Stop button");
  assert.equal((started as { data: Shot }).data.id, 42);
});

test("H-6: the shot is not replayed once it has ended", async () => {
  const { hub, url, stop } = await startHub();
  hub.broadcastShotStarted(shot(42));
  hub.broadcastShotEnded(shot(42), 100);

  const msgs = await snapshot(url);
  stop();

  assert.equal(
    msgs.find((m) => m.type === "shotStarted"),
    undefined,
    "a finished shot must not resurrect a Stop button",
  );
});

test("H-6: the replayed shot carries later field updates", async () => {
  const { hub, url, stop } = await startHub();
  hub.broadcastShotStarted(shot(42));
  hub.broadcastShotUpdated({ ...shot(42), doseG: 18 } as Shot);

  const msgs = await snapshot(url);
  stop();

  const started = msgs.find((m) => m.type === "shotStarted") as { data: Shot } | undefined;
  assert.equal(started?.data.doseG, 18);
});

test("Stufe eines App-Bezugs: ein Client, der mitten im Bezug verbindet, bekommt sie — nach dem Ende nicht mehr", async () => {
  const { hub, url, stop } = await startHub();
  hub.broadcastDriveStage({ index: 0, kind: "preinfusion", name: "Füllen" });
  hub.broadcastShotStarted(shot(42));
  hub.broadcastDriveStage({ index: 1, kind: "flow", name: "Fluss halten" });

  const during = await snapshot(url);
  const stage = during.find((m) => m.type === "driveStage") as { data: unknown } | undefined;
  assert.deepEqual(stage?.data, { index: 1, kind: "flow", name: "Fluss halten" });

  hub.broadcastShotEnded(shot(42), 100);
  const after = await snapshot(url);
  stop();
  assert.equal(after.find((m) => m.type === "driveStage"), undefined);
});
