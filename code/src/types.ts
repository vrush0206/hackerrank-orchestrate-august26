/** Raw rows as emitted by the CSV parser. Numeric and boolean values remain strings. */
export interface IncomingMessageRow {
  message_id: string;
  user_id: string;
  conversation_type: string;
  group_id: string;
  business_id: string;
  sender_user_id: string;
  created_at: string;
  message_text: string;
  media_type: string;
  media_id: string;
  forwarded_count: string;
}

export interface UserConfigurationRow {
  user_id: string;
  do_not_disturb_window: string;
  messages_opened_30d: string;
  messages_replied_30d: string;
  notifications_dismissed_30d: string;
  messages_reported_30d: string;
}

export interface GroupMetadataRow {
  group_id: string;
  group_name: string;
  group_type: string;
  member_count: string;
  admin_count: string;
  created_at: string;
  messages_30d: string;
}

export interface GroupMemberRow {
  group_id: string;
  user_id: string;
  role: string;
  joined_at: string;
  messages_sent_30d: string;
  messages_read_30d: string;
  replies_sent_30d: string;
  notifications_dismissed_30d: string;
  group_muted_by_user: string;
}

export interface HistoricalMessageRow extends IncomingMessageRow {}

export interface HistoricalInteractionRow {
  user_id: string;
  message_id: string;
  message_opened: string;
  message_replied: string;
  reaction_time_minutes: string;
  notification_dismissed: string;
  muted_after_message: string;
  message_reported: string;
}

export interface BusinessAccountRow {
  business_id: string;
  display_name: string;
  brand_name: string;
  category: string;
  verified: string;
  official_domain: string;
  domain_used_by_sender: string;
  account_age_days: string;
  messages_sent_30d: string;
  user_reports_30d: string;
  domain_used_by_sender_age_days: string;
}

export interface UserBusinessHistoryRow {
  user_id: string;
  business_id: string;
  why_user_knows_account: string;
  last_activity_at: string;
  allows_promotions: string;
  promotions_opted_out_at: string;
  activity_count_180d: string;
  messages_opened_30d: string;
  messages_dismissed_30d: string;
  messages_replied_30d: string;
  last_reply_at: string;
}

export interface DailyNotificationSummaryRow {
  user_id: string;
  date: string;
  notifications_sent: string;
  notifications_dismissed: string;
}

export interface HistoricalMessageWithInteraction extends HistoricalMessageRow {
  interaction: HistoricalInteractionRow | null;
  retrieval_score: number;
}
