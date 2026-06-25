import { createHash } from "node:crypto";
import { createServer } from "node:http";

const SHEET_BASE =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTRAjtrKggslKZ32dsGE9GpRizu7qJOMJscTZg04MVDwssg199lNXRClV692KeUdTtkveaM8yiBrThu/pub";

const TABS = [
  { gid: "0" },
  { gid: "1021598529" },
  { gid: "1256027568" },
];

const CHECK_INTERVAL_MS = 60 * 1000;
const PING_INTERVAL_MS = 25 * 1000;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const server = createServer((req, res) => {
  res.writeHead(426, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify({ ok: false, error: "Use a WebSocket connection." }));
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n")
  );

  let closed = false;
  let lastHash = "";
  let checkTimer;
  let pingTimer;

  const cleanup = () => {
    closed = true;
    clearInterval(checkTimer);
    clearInterval(pingTimer);
  };

  const safeSend = (payload) => {
    if (closed || socket.destroyed) return;
    try {
      sendFrame(socket, JSON.stringify(payload));
    } catch {
      socket.destroy();
    }
  };

  const checkForUpdates = async () => {
    try {
      const hash = await sheetHash();
      if (!lastHash) {
        lastHash = hash;
        safeSend({ type: "prices:connected" });
        return;
      }
      if (hash !== lastHash) {
        lastHash = hash;
        safeSend({ type: "price:update", updatedAt: new Date().toISOString() });
      }
    } catch (err) {
      safeSend({ type: "prices:error", message: String((err && err.message) || err) });
    }
  };

  socket.on("data", (chunk) => {
    if (isCloseFrame(chunk)) socket.end(closeFrame());
  });
  socket.on("close", cleanup);
  socket.on("error", cleanup);

  checkTimer = setInterval(checkForUpdates, CHECK_INTERVAL_MS);
  pingTimer = setInterval(() => {
    if (!closed && !socket.destroyed) socket.write(pingFrame());
  }, PING_INTERVAL_MS);

  checkForUpdates();
});

async function sheetHash() {
  const parts = await Promise.all(
    TABS.map(async ({ gid }) => {
      const url = `${SHEET_BASE}?gid=${gid}&single=true&output=csv&_=${Date.now()}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`Sheet ${gid} returned HTTP ${res.status}`);
      return `${gid}:${await res.text()}`;
    })
  );
  return createHash("sha256").update(parts.join("\n---tab---\n")).digest("hex");
}

function sendFrame(socket, text) {
  const payload = Buffer.from(text);
  const header = frameHeader(0x81, payload.length);
  socket.write(Buffer.concat([header, payload]));
}

function pingFrame() {
  return Buffer.from([0x89, 0x00]);
}

function closeFrame() {
  return Buffer.from([0x88, 0x00]);
}

function frameHeader(firstByte, length) {
  if (length < 126) return Buffer.from([firstByte, length]);
  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = firstByte;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return header;
  }
  const header = Buffer.alloc(10);
  header[0] = firstByte;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return header;
}

function isCloseFrame(chunk) {
  return chunk && chunk.length > 0 && (chunk[0] & 0x0f) === 0x08;
}

export default server;
