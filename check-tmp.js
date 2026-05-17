import { Database } from "bun:sqlite";
const path = require("path");
const home = process.env.USERPROFILE;
const db = new Database(path.join(home, ".claudex/db/claudex.db"), {readonly: true});

const rows = db.prepare("SELECT session_id FROM sessions WHERE project='claudex-v3' AND (session_id LIKE 'd2237451%' OR session_id LIKE '6ec39ce7%')").all();

for (const r of rows) {
  const sid = r.session_id;
  console.log("\n=== SESSION", sid.substr(0,8), "===");

  const hl = db.prepare("SELECT mental_model, open_questions, reframes, posture_context, degraded, degraded_reason FROM session_highlights WHERE session_id=?").all(sid);
  if (hl.length) {
    console.log("HIGHLIGHT:");
    for (const h of hl) {
      console.log(`  posture_context: ${(h.posture_context ?? "").substr(0, 800)}`);
      console.log(`  open_questions: ${(h.open_questions ?? "").substr(0, 600)}`);
      console.log(`  reframes: ${(h.reframes ?? "").substr(0, 400)}`);
      console.log(`  mental_model: ${(h.mental_model ?? "").substr(0, 400)}`);
      console.log(`  degraded: ${h.degraded} ${h.degraded_reason ?? ""}`);
    }
  } else console.log("NO HIGHLIGHTS");

  // Last 5 user_framing prompts
  const ufs = db.prepare("SELECT datetime(timestamp_epoch, 'unixepoch', 'localtime') AS ts, detail FROM session_events WHERE session_id=? AND event_type='user_framing' ORDER BY id DESC LIMIT 6").all(sid);
  console.log("LAST_USER_PROMPTS (most recent first):");
  for (const e of ufs) console.log(`  ${e.ts}: ${(e.detail ?? "").substr(0, 280)}`);

  // Last 5 events overall
  const ev = db.prepare("SELECT datetime(timestamp_epoch, 'unixepoch', 'localtime') AS ts, event_type, action FROM session_events WHERE session_id=? ORDER BY id DESC LIMIT 8").all(sid);
  console.log("LAST_EVENT_TYPES:");
  for (const e of ev) console.log(`  ${e.ts} ${e.event_type}/${e.action}`);
}
