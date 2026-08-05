import * as fs from "fs";
import * as path from "path";
import csv from "csv-parser";

import { routingDecisionSchema } from "./schema";

interface CsvRow {
  [column: string]: string;
}

const datasetDir = path.resolve(__dirname, "../../dataset");
const messagesPath = path.join(datasetDir, "messages.csv");
const outputPath = path.join(datasetDir, "output.csv");
const archiveDir = path.resolve(__dirname, "../run-output");

function readCsv(filePath: string): Promise<CsvRow[]> {
  return new Promise((resolve, reject) => {
    const rows: CsvRow[] = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row: CsvRow) => rows.push(row))
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

function duplicateIds(ids: string[]): string[] {
  const counts = new Map<string, number>();
  ids.forEach((id) => counts.set(id, (counts.get(id) ?? 0) + 1));
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id);
}

function archiveOutput(): string {
  fs.mkdirSync(archiveDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = path.join(archiveDir, `output-${timestamp}.csv`);
  fs.copyFileSync(outputPath, destination);
  return destination;
}

export async function validateOutput(): Promise<string> {
  const [allMessages, output] = await Promise.all([
    readCsv(messagesPath),
    readCsv(outputPath),
  ]);
  const configuredLimit = Number(process.env.MESSAGE_LIMIT ?? "0");
  const messages = configuredLimit > 0
    ? allMessages.slice(0, configuredLimit)
    : allMessages;

  const messageIds = messages.map((row) => row.message_id);
  const outputIds = output.map((row) => row.message_id);
  const messageIdSet = new Set(messageIds);
  const outputIdSet = new Set(outputIds);
  const duplicates = duplicateIds(outputIds);
  const missingIds = messageIds.filter((id) => !outputIdSet.has(id));
  const extraIds = outputIds.filter((id) => !messageIdSet.has(id));
  const confidenceZeroIds = output
    .filter((row) => Number(row.confidence) === 0)
    .map((row) => row.message_id);
  const invalidRows: Array<{ message_id: string; error: string }> = [];

  for (const row of output) {
    const parsed = routingDecisionSchema.safeParse({
      action: row.action,
      message_type: row.message_type,
      reason: row.reason,
      confidence: Number(row.confidence),
      evidence_message_ids: row.evidence_message_ids,
    });
    if (!parsed.success) {
      invalidRows.push({
        message_id: row.message_id,
        error: parsed.error.issues.map((issue) => issue.message).join("; "),
      });
    }
  }

  const archivedAt = archiveOutput();
  const countMatches = messages.length === output.length;
  const valid =
    countMatches &&
    duplicates.length === 0 &&
    missingIds.length === 0 &&
    extraIds.length === 0 &&
    confidenceZeroIds.length === 0 &&
    invalidRows.length === 0;

  console.log("\nPost-run output validation");
  console.log(`Input rows: ${messages.length}`);
  console.log(`Output rows: ${output.length}`);
  console.log(`Count match: ${countMatches ? "yes" : "NO"}`);
  console.log(`Duplicate message IDs: ${duplicates.length}`);
  console.log(`Missing message IDs: ${missingIds.length}`);
  console.log(`Extra message IDs: ${extraIds.length}`);
  console.log(`Confidence-zero rows: ${confidenceZeroIds.length}`);
  console.log(`Schema-invalid rows: ${invalidRows.length}`);
  console.log(`Archived output: ${archivedAt}`);

  if (duplicates.length) console.error("Duplicate IDs:", duplicates.join(", "));
  if (missingIds.length) console.error("Missing IDs:", missingIds.join(", "));
  if (extraIds.length) console.error("Extra IDs:", extraIds.join(", "));
  if (confidenceZeroIds.length) {
    console.error("Confidence-zero IDs:", confidenceZeroIds.join(", "));
  }
  if (invalidRows.length) console.error("Invalid rows:", invalidRows);

  if (!valid) {
    throw new Error("Output validation failed; inspect the report above.");
  }
  console.log("Output validation passed.");
  return archivedAt;
}

if (require.main === module) {
  validateOutput().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
