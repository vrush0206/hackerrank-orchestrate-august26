import { DataAggregator } from "./aggregator";
import { classifyMessages } from "./main";
import { routingDecisionSchema } from "./schema";
import type { IncomingMessageRow } from "./types";

const sampleMessages: IncomingMessageRow[] = [
  {
    message_id: "msg_mock_001",
    user_id: "user_101",
    conversation_type: "group",
    group_id: "group_555",
    business_id: "",
    sender_user_id: "user_999",
    created_at: "2026-08-03T23:15:00Z",
    message_text:
      "Urgent: Water main leak detected on Main St. Main valve shutting down in 10 mins.",
    media_type: "",
    media_id: "",
    forwarded_count: "0",
  },
  {
    message_id: "msg_mock_002",
    user_id: "user_101",
    conversation_type: "business",
    group_id: "",
    business_id: "biz_scam_777",
    sender_user_id: "",
    created_at: "2026-08-03T14:00:00Z",
    message_text:
      "CONGRATULATIONS! You won a $1000 Crypto Voucher! Click ://tinyurl.com NOW!",
    media_type: "",
    media_id: "",
    forwarded_count: "45",
  },
];

async function runMockTest(): Promise<void> {
  console.log("Starting synthetic verification harness...");

  const aggregator = new DataAggregator();
  aggregator.userMap.set("user_101", {
    user_id: "user_101",
    do_not_disturb_window: "22:00-06:00",
    messages_opened_30d: "25",
    messages_replied_30d: "8",
    notifications_dismissed_30d: "3",
    messages_reported_30d: "0",
  });
  aggregator.groupMap.set("group_555", {
    group_id: "group_555",
    group_name: "Neighborhood Notices",
    group_type: "neighborhood_notice",
    member_count: "140",
    admin_count: "4",
    created_at: "2024-01-01T00:00:00Z",
    messages_30d: "80",
  });
  aggregator.businessMap.set("biz_scam_777", {
    business_id: "biz_scam_777",
    display_name: "Unknown Rewards",
    brand_name: "Unknown Rewards",
    category: "other",
    verified: "false",
    official_domain: "",
    domain_used_by_sender: "tinyurl.com",
    account_age_days: "2",
    messages_sent_30d: "5000",
    user_reports_30d: "200",
    domain_used_by_sender_age_days: "2",
  });

  const results = await classifyMessages(sampleMessages, aggregator);
  for (const { messageId, decision: rawDecision } of results) {
    const decision = routingDecisionSchema.parse(rawDecision);
    console.log(`${messageId}: ${JSON.stringify(decision)}`);
  }

  console.log("Synthetic verification completed successfully.");
}

runMockTest().catch((error: unknown) => {
  console.error("Synthetic verification failed:", error);
  process.exitCode = 1;
});
