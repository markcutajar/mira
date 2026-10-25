// Hook recorder: a throwaway spike to see what Claude Code hooks really send.
//
// Records the shape of each hook payload (key names, value types, string
// lengths) so the event envelope can be designed from real traffic. Values are
// dropped except IDs, paths, names and enum-like fields, so no code or
// transcript content is written to disk.
//
// Run:    node tools/hook-recorder/recorder.mjs
// Output: ~/.mira/recordings/hooks-YYYY-MM-DD.jsonl (override with MIRA_RECORDINGS_DIR)
//
// Always replies 204 with an empty body, which Claude Code treats as success
// with no decision, so a session behaves exactly as it would without Mira.

import { createServer } from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.MIRA_PORT ?? 4711);
const DIR = process.env.MIRA_RECORDINGS_DIR ?? join(homedir(), ".mira", "recordings");
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 4;

// Kept verbatim when the value is a string. Everything else is reduced to its shape.
const KEEP = new Set([
  "hook_event_name", "session_id", "prompt_id", "cwd", "transcript_path",
  "permission_mode", "effort", "agent_id", "agent_type", "agent_transcript_path",
  "tool_name", "tool_use_id",
]);
const KEEP_FOR_EVENT = {
  SessionStart: ["source", "model"],
  SessionEnd: ["reason"],
  StopFailure: ["error"],
  Notification: ["notification_type"],
};

function shape(value, depth = 0) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "array(0)";
    return { [`array(${value.length})`]: shape(value[0], depth + 1) };
  }
  if (typeof value === "object") {
    if (depth >= MAX_DEPTH) return `object(${Object.keys(value).length} keys)`;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, depth + 1)]));
  }
  if (typeof value === "string") return `string(${value.length})`;
  return typeof value;
}

function toLine(source, payload, bytes) {
  const keep = new Set([...KEEP, ...(KEEP_FOR_EVENT[payload.hook_event_name] ?? [])]);
  const values = {};
  const rest = {};
  for (const [key, value] of Object.entries(payload)) {
    const keepString = keep.has(key) && typeof value === "string";
    // Top-level numbers and booleans are durations, counts and flags, never content.
    if (keepString || typeof value === "number" || typeof value === "boolean") values[key] = value;
    else rest[key] = shape(value);
  }
  return { received_at: new Date().toISOString(), source, bytes, values, shape: rest };
}

let writes = Promise.resolve();
function save(line) {
  const file = join(DIR, `hooks-${line.received_at.slice(0, 10)}.jsonl`);
  writes = writes
    .then(() => appendFile(file, JSON.stringify(line) + "\n"))
    .catch((err) => console.error(`write failed: ${err.message}`));
}

function describe(line) {
  const v = line.values;
  const time = line.received_at.slice(11, 19);
  const session = (v.session_id ?? "?").slice(0, 8);
  const where = v.cwd ? basename(v.cwd) : "?";
  const detail = v.tool_name ?? v.notification_type ?? v.source ?? v.reason ?? v.error ?? "";
  return `${time}  ${(v.hook_event_name ?? "?").padEnd(18)} ${session}  ${where}  ${detail}`;
}

const server = createServer((req, res) => {
  if (req.method !== "POST" || !req.url.startsWith("/ingest/")) {
    res.writeHead(404).end();
    return;
  }
  const source = req.url.slice("/ingest/".length);
  const chunks = [];
  let bytes = 0;
  req.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes <= MAX_BODY_BYTES) chunks.push(chunk);
  });
  req.on("end", () => {
    res.writeHead(204).end();
    if (bytes > MAX_BODY_BYTES) {
      save({ received_at: new Date().toISOString(), source, bytes, oversized: true });
      console.warn(`oversized payload (${bytes} bytes) from ${source}, shape not recorded`);
      return;
    }
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (err) {
      console.warn(`unparseable payload (${bytes} bytes) from ${source}: ${err.message}`);
      return;
    }
    const line = toLine(source, payload, bytes);
    save(line);
    console.log(describe(line));
  });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") console.error(`port ${PORT} is already in use; is the recorder already running?`);
  else console.error(err.message);
  process.exit(1);
});

await mkdir(DIR, { recursive: true });
server.listen(PORT, HOST, () => {
  console.log(`recording hook shapes on http://${HOST}:${PORT}/ingest/<source> to ${DIR}`);
});
