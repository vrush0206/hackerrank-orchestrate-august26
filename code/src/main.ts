import * as fs from "fs";
import * as path from "path";
import { once } from "events";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject, type UserContent } from "ai";
import csv from "csv-parser";
import * as dotenv from "dotenv";

import { DataAggregator } from "./aggregator";
import { appendRunError, updateRunStatus, type RunError } from "./dashboard";
import {
  batchRoutingDecisionSchema,
  routingDecisionSchema,
  type BatchRoutingDecision,
  type RoutingDecision,
} from "./schema";
import type { IncomingMessageRow } from "./types";

dotenv.config();

const datasetDir = path.resolve(__dirname, "../../dataset");
const inputPath = path.join(datasetDir, "messages.csv");
const outputPath = path.join(datasetDir, "output.csv");
const pendingOutputPath = path.join(datasetDir, "output.pending.csv");
const runOutputDir = path.resolve(__dirname, "../run-output");
const modelId = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
const minimumRequestIntervalMs = integerSetting("GEMINI_MIN_INTERVAL_MS", 15_000, 1_000);
const maximumRequestFailures = integerSetting("GEMINI_MAX_REQUEST_FAILURES", 2, 1);
const batchSize = integerSetting("MESSAGE_BATCH_SIZE", 10, 1, 50);
const configuredMessageLimit = integerSetting("MESSAGE_LIMIT", 0, 0);
const messageLimit = configuredMessageLimit > 0 ? configuredMessageLimit : Infinity;
let nextRequestAt = 0;
let runtimeErrorLogPath: string | null = null;
const recordedErrorObjects = new WeakSet<object>();
let cachedInputScan: Promise<Awaited<ReturnType<typeof scanInput>>> | null = null;
let cachedAggregator: Promise<DataAggregator> | null = null;

const systemPrompt = `You are a deterministic WhatsApp notification router.

ACTION POLICY
- notify: use for real-time safety issues and critical personal alerts that require immediate attention.
- digest: use for low-priority informational items that can wait.
- mute: use for unsolicited mass advertisements, repetitive noise, and security risks such as spam, phishing, or scams.

MESSAGE CATEGORY POLICY
Select exactly one of: personal, urgent, event, payment, business_update, promotion, greeting, forward, spam, scam, unknown.

OUTPUT POLICY
- Follow the supplied output schema exactly and do not add fields.
- Base the decision on the incoming message, user preferences, channel metadata, business trust, historical interactions, notification load, and attached media.
- Set confidence between 0 and 1.
- Set evidence_message_ids to "none" when history is not useful; otherwise provide only relevant historical message IDs separated by semicolons.`;

const outputColumns = [
  "message_id",
  "action",
  "message_type",
  "reason",
  "confidence",
  "evidence_message_ids",
] as const;

interface EncodedMedia {
  base64: string;
  mediaType: string;
  filename: string;
}

type UserContentParts = Exclude<UserContent, string>;

function integerSetting(
  name: string,
  fallback: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function ensureRuntimeErrorLog(): string {
  if (runtimeErrorLogPath) return runtimeErrorLogPath;
  fs.mkdirSync(runOutputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  runtimeErrorLogPath = path.join(runOutputDir, `errors-${timestamp}.jsonl`);
  fs.writeFileSync(runtimeErrorLogPath, "", "utf8");
  updateRunStatus({ errorLogPath: runtimeErrorLogPath });
  return runtimeErrorLogPath;
}

function recordRuntimeError(
  error: unknown,
  messages: IncomingMessageRow[],
  attempt: number,
  recoverable: boolean,
): void {
  const entry: RunError = {
    timestamp: new Date().toISOString(),
    messageIds: messages.map((message) => message.message_id),
    attempt,
    recoverable,
    message: errorMessage(error),
  };
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    recordedErrorObjects.add(error);
  }
  fs.appendFileSync(ensureRuntimeErrorLog(), `${JSON.stringify(entry)}\n`, "utf8");
  appendRunError(entry);
}

export function recordFatalRunError(error: unknown): void {
  if (
    ((typeof error === "object" && error !== null) || typeof error === "function") &&
    recordedErrorObjects.has(error)
  ) {
    return;
  }
  recordRuntimeError(error, [], maximumRequestFailures, false);
}

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!key) {
    throw new Error(
      "Set GEMINI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY before running the router.",
    );
  }
  return key;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function scanInput(filePath: string): Promise<{
  total: number;
  conversationTypes: Record<string, number>;
  mediaTypes: Record<string, number>;
}> {
  return new Promise((resolve, reject) => {
    const result = {
      total: 0,
      conversationTypes: {} as Record<string, number>,
      mediaTypes: {} as Record<string, number>,
    };
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row: IncomingMessageRow) => {
        if (result.total >= messageLimit) return;
        result.total += 1;
        const conversation = row.conversation_type || "unknown";
        const media = row.media_type || "text";
        result.conversationTypes[conversation] =
          (result.conversationTypes[conversation] ?? 0) + 1;
        result.mediaTypes[media] = (result.mediaTypes[media] ?? 0) + 1;
      })
      .on("end", () => resolve(result))
      .on("error", reject);
  });
}

async function preparedData(): Promise<{
  input: Awaited<ReturnType<typeof scanInput>>;
  data: DataAggregator;
}> {
  cachedInputScan ??= scanInput(inputPath);
  cachedAggregator ??= (async () => {
    const data = new DataAggregator();
    await data.initialize();
    return data;
  })();
  const [input, data] = await Promise.all([cachedInputScan, cachedAggregator]);
  return { input, data };
}

export async function prepareDataOverview(): Promise<void> {
  updateRunStatus({ phase: "initializing", lastError: null });
  const { input, data } = await preparedData();
  updateRunStatus({
    phase: "idle",
    total: input.total,
    inputStats: {
      conversationTypes: input.conversationTypes,
      mediaTypes: input.mediaTypes,
    },
    dataInsights: data.getDatasetInsights(),
  });
}

async function waitForRequestSlot(): Promise<void> {
  const delay = Math.max(0, nextRequestAt - Date.now());
  if (delay > 0) await sleep(delay);
  nextRequestAt = Date.now() + minimumRequestIntervalMs;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = "cause" in error ? error.cause : undefined;
    return cause ? `${error.message}\n${errorMessage(cause)}` : error.message;
  }
  return String(error);
}

function isQuotaError(error: unknown): boolean {
  const message = errorMessage(error);
  return /quota exceeded|exceeded your current quota|rate.?limit|status.?429/i.test(
    message,
  );
}

function quotaRetryDelayMs(error: unknown): number {
  const match = errorMessage(error).match(/retry in\s+([\d.]+)s/i);
  const providerDelay = match ? Math.ceil(Number(match[1]) * 1000) + 1_000 : 60_000;
  return Math.max(minimumRequestIntervalMs, providerDelay);
}

function canSplitBatch(error: unknown): boolean {
  return /payload|request.*too large|token limit|context length|status.?413|Batch response message IDs|Batch omitted/i.test(
    errorMessage(error),
  );
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function mediaType(filePath: string, kind: "image" | "voice"): string {
  const extension = path.extname(filePath).toLowerCase();
  const knownTypes: Record<string, string> = {
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".webm": "audio/webm",
  };
  return knownTypes[extension] ?? (kind === "image" ? "image/jpeg" : "audio/ogg");
}

function encodeMedia(relativePath: string, kind: "image" | "voice"): EncodedMedia {
  const absolutePath = path.resolve(datasetDir, relativePath);
  const relativeToDataset = path.relative(datasetDir, absolutePath);

  if (relativeToDataset.startsWith("..") || path.isAbsolute(relativeToDataset)) {
    throw new Error(`Media path escapes the dataset directory: ${relativePath}`);
  }
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Media file is missing: ${relativePath}`);
  }

  return {
    base64: fs.readFileSync(absolutePath).toString("base64"),
    mediaType: mediaType(absolutePath, kind),
    filename: path.basename(absolutePath),
  };
}

function buildPromptContext(message: IncomingMessageRow, data: DataAggregator): string {
  const context = {
    incoming_message: message,
    notification_preferences: data.userMap.get(message.user_id) ?? null,
    channel: {
      conversation_type: message.conversation_type,
      group: message.group_id ? data.groupMap.get(message.group_id) ?? null : null,
      group_membership: message.group_id
        ? data.getGroupMembership(message.user_id, message.group_id)
        : null,
      business: message.business_id
        ? data.businessMap.get(message.business_id) ?? null
        : null,
      user_business_relationship: message.business_id
        ? data.getUserBusinessHistory(message.user_id, message.business_id)
        : null,
      sender_user_id: message.sender_user_id || null,
    },
    historical_timeline: data.getHistoricalTimeline(message),
    recent_notification_load: data.getRecentNotificationSummaries(message.user_id),
  };

  return [
    "Route this WhatsApp message for the receiving user.",
    "Use only relevant historical message IDs as evidence.",
    JSON.stringify(context),
  ].join("\n\n");
}

function appendMessageContent(
  content: UserContentParts,
  message: IncomingMessageRow,
  data: DataAggregator,
): void {
  const text = buildPromptContext(message, data);
  const imagePath =
    message.media_type === "image" ? data.imageMap.get(message.media_id) : undefined;
  const voicePath =
    message.media_type === "voice" ? data.voiceMap.get(message.media_id) : undefined;

  if (message.media_type === "image" && !imagePath) {
    throw new Error(`No image mapping found for media_id ${message.media_id}`);
  }
  if (message.media_type === "voice" && !voicePath) {
    throw new Error(`No voice-note mapping found for media_id ${message.media_id}`);
  }

  content.push({
    type: "text",
    text: `MESSAGE ${message.message_id}\n${text}`,
  });
  if (imagePath) {
    const image = encodeMedia(imagePath, "image");
    content.push({
      type: "image",
      image: image.base64,
      mediaType: image.mediaType,
    });
  }
  if (voicePath) {
    const voice = encodeMedia(voicePath, "voice");
    content.push({
      type: "file",
      data: voice.base64,
      mediaType: voice.mediaType,
      filename: voice.filename,
    });
  }
}

async function classifyBatch(
  messages: IncomingMessageRow[],
  data: DataAggregator,
): Promise<Array<{ messageId: string; decision: RoutingDecision }>> {
  const content: UserContentParts = [
    {
      type: "text",
      text:
        `Classify exactly ${messages.length} messages. Return exactly one decision for every ` +
        "message_id below. Do not omit, duplicate, or invent message IDs.",
    },
  ];
  messages.forEach((message) => appendMessageContent(content, message, data));

  await waitForRequestSlot();
  const google = createGoogleGenerativeAI({ apiKey: apiKey() });
  const result = await generateObject({
    model: google(modelId),
    schema: batchRoutingDecisionSchema,
    system: systemPrompt,
    maxRetries: 0,
    messages: [{ role: "user", content }],
  });

  const parsed = batchRoutingDecisionSchema.parse(result.object);
  return validateBatchDecisions(parsed, messages, data);
}

export function validateBatchDecisions(
  parsed: BatchRoutingDecision,
  messages: IncomingMessageRow[],
  data: DataAggregator,
): Array<{ messageId: string; decision: RoutingDecision }> {
  const byId = new Map(
    parsed.decisions.map(({ message_id, ...decision }) => [message_id, decision]),
  );
  const expectedIds = new Set(messages.map((message) => message.message_id));
  if (
    parsed.decisions.length !== messages.length ||
    byId.size !== messages.length ||
    parsed.decisions.some((decision) => !expectedIds.has(decision.message_id))
  ) {
    throw new Error("Batch response message IDs do not match the requested batch.");
  }
  return messages.map((message) => {
    const decision = byId.get(message.message_id);
    if (!decision) throw new Error(`Batch omitted message ${message.message_id}.`);
    if (decision.evidence_message_ids !== "none") {
      const allowedEvidence = new Set(
        data.getHistoricalTimeline(message).map((historical) => historical.message_id),
      );
      const invalidEvidence = decision.evidence_message_ids
        .split(";")
        .filter((id) => !allowedEvidence.has(id));
      if (invalidEvidence.length) {
        throw new Error(
          `Invalid evidence IDs for ${message.message_id}: ${invalidEvidence.join(", ")}`,
        );
      }
    }
    return { messageId: message.message_id, decision };
  });
}

export async function classifyMessage(
  message: IncomingMessageRow,
  data: DataAggregator,
): Promise<RoutingDecision> {
  return (await classifyMessages([message], data))[0].decision;
}

export async function classifyMessages(
  messages: IncomingMessageRow[],
  data: DataAggregator,
): Promise<Array<{ messageId: string; decision: RoutingDecision }>> {
  return classifyBatch(messages, data);
}

async function classifyBatchWithRetry(
  messages: IncomingMessageRow[],
  data: DataAggregator,
): Promise<Array<{ messageId: string; decision: RoutingDecision }>> {
  for (let failures = 0; ; ) {
    try {
      return await classifyBatch(messages, data);
    } catch (error) {
      failures += 1;
      recordRuntimeError(
        error,
        messages,
        failures,
        failures < maximumRequestFailures,
      );
      if (failures >= maximumRequestFailures) throw error;

      const delay = isQuotaError(error)
        ? quotaRetryDelayMs(error)
        : minimumRequestIntervalMs;
      console.warn(
        `Gemini batch request failed; retrying in ${Math.ceil(delay / 1000)}s ` +
          `(${failures}/${maximumRequestFailures} failures).`,
      );
      await sleep(delay);
    }
  }
}

async function classifyBatchResilient(
  messages: IncomingMessageRow[],
  data: DataAggregator,
): Promise<Array<{ messageId: string; decision: RoutingDecision }>> {
  try {
    return await classifyBatchWithRetry(messages, data);
  } catch (error) {
    if (messages.length <= 1 || !canSplitBatch(error)) throw error;
    const middle = Math.ceil(messages.length / 2);
    const left = messages.slice(0, middle);
    const right = messages.slice(middle);
    recordRuntimeError(error, messages, maximumRequestFailures, true);
    console.warn(`Splitting failed batch of ${messages.length} into ${left.length} and ${right.length}.`);
    return [
      ...(await classifyBatchResilient(left, data)),
      ...(await classifyBatchResilient(right, data)),
    ];
  }
}

async function writeRow(
  output: fs.WriteStream,
  messageId: string,
  decision: RoutingDecision,
): Promise<void> {
  const row = [
    messageId,
    decision.action,
    decision.message_type,
    decision.reason,
    decision.confidence,
    decision.evidence_message_ids,
  ]
    .map(csvCell)
    .join(",");
  if (!output.write(`${row}\n`)) await once(output, "drain");
}

export async function runProduction(): Promise<void> {
  apiKey();
  updateRunStatus({
    phase: "initializing",
    processed: 0,
    total: 0,
    currentMessageId: null,
    model: modelId,
    rpm: Math.floor(60_000 / minimumRequestIntervalMs),
    startedAt: new Date().toISOString(),
    lastError: null,
    errorHistory: [],
    errorLogPath: null,
    archivePath: null,
    inputStats: { conversationTypes: {}, mediaTypes: {} },
    dataInsights: {},
    outputStats: { actions: {}, messageTypes: {}, averageConfidence: 0 },
    lastDecision: null,
  });
  ensureRuntimeErrorLog();
  const { input, data } = await preparedData();
  updateRunStatus({
    phase: "running",
    total: input.total,
    inputStats: {
      conversationTypes: input.conversationTypes,
      mediaTypes: input.mediaTypes,
    },
    dataInsights: data.getDatasetInsights(),
  });
  console.log(
    `Processing ${input.total} messages in batches of up to ${batchSize} ` +
      `(${Math.ceil(input.total / batchSize)} Gemini calls).`,
  );

  const output = fs.createWriteStream(pendingOutputPath, {
    encoding: "utf8",
    flags: "w",
  });
  output.write(`${outputColumns.join(",")}\n`);

  try {
    const messages = fs.createReadStream(inputPath).pipe(csv());
    let processed = 0;
    let confidenceTotal = 0;
    const actions: Record<string, number> = {};
    const messageTypes: Record<string, number> = {};
    let batch: IncomingMessageRow[] = [];
    const processBatch = async (): Promise<void> => {
      if (!batch.length) return;
      const currentBatch = batch;
      batch = [];
      updateRunStatus({
        currentMessageId: `${currentBatch[0].message_id} ... ${currentBatch[currentBatch.length - 1].message_id}`,
        lastError: null,
      });
      const results = await classifyBatchResilient(currentBatch, data);
      for (const { messageId, decision } of results) {
        await writeRow(output, messageId, decision);
        processed += 1;
        confidenceTotal += decision.confidence;
        actions[decision.action] = (actions[decision.action] ?? 0) + 1;
        messageTypes[decision.message_type] =
          (messageTypes[decision.message_type] ?? 0) + 1;
        updateRunStatus({
          processed,
          outputStats: {
            actions: { ...actions },
            messageTypes: { ...messageTypes },
            averageConfidence: confidenceTotal / processed,
          },
          lastDecision: {
            messageId,
            action: decision.action,
            messageType: decision.message_type,
            confidence: decision.confidence,
          },
        });
      }
    };
    for await (const row of messages) {
      if (processed + batch.length >= input.total) break;
      batch.push(row as IncomingMessageRow);
      if (batch.length >= batchSize) await processBatch();
    }
    await processBatch();
  } finally {
    output.end();
    await once(output, "finish");
  }
  fs.copyFileSync(pendingOutputPath, outputPath);
  fs.unlinkSync(pendingOutputPath);
}

if (require.main === module) {
  runProduction().catch((error: unknown) => {
    console.error("Message routing failed:", error);
    process.exitCode = 1;
  });
}
