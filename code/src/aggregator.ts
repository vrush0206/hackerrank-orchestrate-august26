import * as fs from "fs";
import * as path from "path";
import csv from "csv-parser";

import type {
  BusinessAccountRow,
  DailyNotificationSummaryRow,
  GroupMemberRow,
  GroupMetadataRow,
  HistoricalInteractionRow,
  HistoricalMessageRow,
  HistoricalMessageWithInteraction,
  IncomingMessageRow,
  UserBusinessHistoryRow,
  UserConfigurationRow,
} from "./types";

function compositeKey(...parts: string[]): string {
  return parts.join("\u0000");
}

function channelId(message: IncomingMessageRow): string {
  return message.group_id || message.business_id || message.sender_user_id;
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length > 2),
  );
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  left.forEach((token) => {
    if (right.has(token)) intersection += 1;
  });
  return intersection / (left.size + right.size - intersection);
}

function trueSignal(value: string | undefined): number {
  return /^(?:1|true|yes)$/i.test(value ?? "") ? 1 : 0;
}

export class DataAggregator {
  public readonly userMap = new Map<string, UserConfigurationRow>();
  public readonly groupMap = new Map<string, GroupMetadataRow>();
  public readonly groupMemberMap = new Map<string, GroupMemberRow>();
  public readonly businessMap = new Map<string, BusinessAccountRow>();
  public readonly userBusinessMap = new Map<string, UserBusinessHistoryRow>();
  public readonly imageMap = new Map<string, string>();
  public readonly voiceMap = new Map<string, string>();
  public readonly historyMap = new Map<string, HistoricalMessageRow[]>();
  public readonly messageEventMap = new Map<string, HistoricalInteractionRow>();
  public readonly notificationSummaryMap = new Map<string, DailyNotificationSummaryRow[]>();

  private readonly datasetDir = path.resolve(__dirname, "../../dataset");

  private parseCSV<T extends object>(filename: string): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const results: T[] = [];
      const filePath = path.join(this.datasetDir, filename);

      if (!fs.existsSync(filePath)) {
        reject(new Error(`Required dataset file is missing: ${filePath}`));
        return;
      }

      fs.createReadStream(filePath)
        .pipe(csv())
        .on("data", (row: T) => results.push(row))
        .on("end", () => resolve(results))
        .on("error", reject);
    });
  }

  async initialize(): Promise<void> {
    console.log("Initializing data indexes...");

    const [
      users,
      groups,
      groupMembers,
      businesses,
      userBusinessHistory,
      images,
      voiceNotes,
      history,
      messageEvents,
      notificationSummaries,
    ] = await Promise.all([
      this.parseCSV<UserConfigurationRow>("users.csv"),
      this.parseCSV<GroupMetadataRow>("groups.csv"),
      this.parseCSV<GroupMemberRow>("group_members.csv"),
      this.parseCSV<BusinessAccountRow>("business_accounts.csv"),
      this.parseCSV<UserBusinessHistoryRow>("user_business_history.csv"),
      this.parseCSV<{ image_id: string; file_path: string }>("images.csv"),
      this.parseCSV<{ voice_note_id: string; file_path: string }>("voice_notes.csv"),
      this.parseCSV<HistoricalMessageRow>("message_history.csv"),
      this.parseCSV<HistoricalInteractionRow>("message_events.csv"),
      this.parseCSV<DailyNotificationSummaryRow>("daily_notification_summary.csv"),
    ]);

    users.forEach((row) => this.userMap.set(row.user_id, row));
    groups.forEach((row) => this.groupMap.set(row.group_id, row));
    groupMembers.forEach((row) =>
      this.groupMemberMap.set(compositeKey(row.user_id, row.group_id), row),
    );
    businesses.forEach((row) => this.businessMap.set(row.business_id, row));
    userBusinessHistory.forEach((row) =>
      this.userBusinessMap.set(compositeKey(row.user_id, row.business_id), row),
    );
    images.forEach((row) => this.imageMap.set(row.image_id, row.file_path));
    voiceNotes.forEach((row) => this.voiceMap.set(row.voice_note_id, row.file_path));
    messageEvents.forEach((row) =>
      this.messageEventMap.set(compositeKey(row.user_id, row.message_id), row),
    );

    for (const row of history) {
      const key = compositeKey(row.user_id, row.conversation_type, channelId(row));
      const messages = this.historyMap.get(key) ?? [];
      messages.push(row);
      this.historyMap.set(key, messages);
    }
    for (const messages of this.historyMap.values()) {
      messages.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    }

    for (const row of notificationSummaries) {
      const summaries = this.notificationSummaryMap.get(row.user_id) ?? [];
      summaries.push(row);
      this.notificationSummaryMap.set(row.user_id, summaries);
    }
    for (const summaries of this.notificationSummaryMap.values()) {
      summaries.sort((a, b) => b.date.localeCompare(a.date));
    }

    console.log("Data indexes initialized.");
  }

  getGroupMembership(userId: string, groupId: string): GroupMemberRow | null {
    return this.groupMemberMap.get(compositeKey(userId, groupId)) ?? null;
  }

  getUserBusinessHistory(
    userId: string,
    businessId: string,
  ): UserBusinessHistoryRow | null {
    return this.userBusinessMap.get(compositeKey(userId, businessId)) ?? null;
  }

  getHistoricalTimeline(message: IncomingMessageRow): HistoricalMessageWithInteraction[] {
    const key = compositeKey(
      message.user_id,
      message.conversation_type,
      channelId(message),
    );
    const incomingTokens = tokens(message.message_text);
    const incomingTime = Date.parse(message.created_at);
    return (this.historyMap.get(key) ?? [])
      .map((historicalMessage) => {
        const interaction =
          this.messageEventMap.get(
            compositeKey(message.user_id, historicalMessage.message_id),
          ) ?? null;
        const ageDays = Math.max(
          0,
          (incomingTime - Date.parse(historicalMessage.created_at)) / 86_400_000,
        );
        const recency = Math.exp(-ageDays / 30);
        const similarity = jaccardSimilarity(
          incomingTokens,
          tokens(historicalMessage.message_text),
        );
        const interactionStrength = interaction
          ? Math.min(
              1,
              0.2 * trueSignal(interaction.message_opened) +
                0.35 * trueSignal(interaction.message_replied) +
                0.15 * trueSignal(interaction.notification_dismissed) +
                0.15 * trueSignal(interaction.muted_after_message) +
                0.35 * trueSignal(interaction.message_reported),
            )
          : 0;
        return {
          ...historicalMessage,
          interaction,
          retrieval_score: Number(
            (0.45 * similarity + 0.3 * recency + 0.25 * interactionStrength).toFixed(4),
          ),
        };
      })
      .sort((a, b) => b.retrieval_score - a.retrieval_score)
      .slice(0, 5);
  }

  getRecentNotificationSummaries(userId: string): DailyNotificationSummaryRow[] {
    return (this.notificationSummaryMap.get(userId) ?? []).slice(0, 7);
  }

  getDatasetInsights(): Record<string, number> {
    return {
      users: this.userMap.size,
      groups: this.groupMap.size,
      group_memberships: this.groupMemberMap.size,
      businesses: this.businessMap.size,
      user_business_relationships: this.userBusinessMap.size,
      historical_messages: [...this.historyMap.values()].reduce(
        (total, messages) => total + messages.length,
        0,
      ),
      interaction_events: this.messageEventMap.size,
      images: this.imageMap.size,
      voice_notes: this.voiceMap.size,
      users_with_notification_summaries: this.notificationSummaryMap.size,
    };
  }
}
