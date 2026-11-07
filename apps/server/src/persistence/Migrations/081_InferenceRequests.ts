import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE inference_requests (
    request_id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    model TEXT NOT NULL,
    thread_id TEXT,
    run_id TEXT,
    purpose TEXT NOT NULL,
    status TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    queue_wait_ms INTEGER,
    ttft_ms INTEGER,
    decode_ms INTEGER,
    duration_ms INTEGER,
    prompt_tokens INTEGER,
    cached_prompt_tokens INTEGER,
    completion_tokens INTEGER
  )`;
  yield* sql`CREATE INDEX idx_inference_requests_received ON inference_requests(received_at)`;
  yield* sql`CREATE INDEX idx_inference_requests_thread
    ON inference_requests(thread_id, received_at) WHERE thread_id IS NOT NULL`;
});
