import { strict as assert } from "assert";

import { DataAggregator } from "./aggregator";
import { classifyMessages, validateBatchDecisions } from "./main";
import { batchRoutingDecisionSchema } from "./schema";
import type { IncomingMessageRow } from "./types";

const message = (overrides: Partial<IncomingMessageRow> = {}): IncomingMessageRow => ({
  message_id: "m1",
  user_id: "u1",
  conversation_type: "personal",
  group_id: "",
  business_id: "",
  sender_user_id: "sender1",
  created_at: "2026-08-05T00:00:00Z",
  message_text: "hello",
  media_type: "",
  media_id: "",
  forwarded_count: "0",
  ...overrides,
});

async function run(): Promise<void> {
  const data = new DataAggregator();

  assert.equal(
    batchRoutingDecisionSchema.safeParse({
      decisions: [
        {
          message_id: "m1",
          action: "notify",
          message_type: "personal",
          reason: "test",
          confidence: 2,
          evidence_message_ids: "none",
        },
      ],
    }).success,
    false,
    "out-of-range confidence must fail",
  );

  assert.throws(
    () => validateBatchDecisions({ decisions: [] }, [message()], data),
    /message IDs do not match/,
    "omitted batch IDs must fail",
  );

  assert.throws(
    () =>
      validateBatchDecisions(
        {
          decisions: [
            {
              message_id: "m1",
              action: "digest",
              message_type: "personal",
              reason: "test",
              confidence: 0.7,
              evidence_message_ids: "invented_history_id",
            },
          ],
        },
        [message()],
        data,
      ),
    /Invalid evidence IDs/,
    "invented evidence IDs must fail",
  );

  await assert.rejects(
    () => classifyMessages([message({ media_type: "image", media_id: "missing" })], data),
    /No image mapping found/,
    "missing media mappings must fail before an API request",
  );

  console.log("Offline edge-case tests passed.");
}

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
