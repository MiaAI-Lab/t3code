import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE inference_requests ADD COLUMN parent_run_id TEXT`;
  yield* sql`ALTER TABLE inference_requests ADD COLUMN fallback_from TEXT`;
  yield* sql`ALTER TABLE inference_requests ADD COLUMN static_prefix_hash TEXT`;
});
