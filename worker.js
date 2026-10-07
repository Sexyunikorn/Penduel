import { DurableObject } from "cloudflare:workers";

const TOPICS = new Set(["join", "start", "shot", "rest", "over"]);

// One Room = one duel (max 2 players). Messages are relayed to everyone in the room, sender included (flagged m:true).
export class Room extends DurableObject {
  async fetch(req) {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
    const mode = new URL(req.url).searchParams.get("r"); // c = create, j = join
    const count = this.ctx.getWebSockets().length;
    const [client, server] = Object.values(new WebSocketPair());
    let err = null;
    if (mode === "c" && count > 0) err = "taken";
    else if (mode === "j" && count === 0) err = "none";
    else if (count >= 2) err = "full";
    if (err) {
      server.accept();
      server.send(JSON.stringify({ t: "err", d: err }));
      server.close(1000, err);
    } else {
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ id: crypto.randomUUID() });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, msg) {
    if (typeof msg !== "string" || msg.length > 4096) return;
    let m;
    try { m = JSON.parse(msg); } catch { return; }
    if (!m || !TOPICS.has(m.t)) return;
    const me = ws.deserializeAttachment()?.id;
    for (const s of this.ctx.getWebSockets()) {
      try { s.send(JSON.stringify({ t: m.t, d: m.d, m: s.deserializeAttachment()?.id === me })); } catch {}
    }
  }

  webSocketClose(ws) { this.#left(ws); try { ws.close(); } catch {} }
  webSocketError(ws) { this.#left(ws); }

  #left(ws) {
    const me = ws.deserializeAttachment()?.id;
    for (const s of this.ctx.getWebSockets()) {
      if (s.deserializeAttachment()?.id !== me) { try { s.send(JSON.stringify({ t: "left" })); } catch {} }
    }
  }
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname.startsWith("/ws/")) {
      const code = u.pathname.slice(4).toLowerCase();
      if (!/^[a-z]{4}$/.test(code)) return new Response("Bad code", { status: 400 });
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};
