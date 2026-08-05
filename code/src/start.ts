import "dotenv/config";

import { startDashboard, updateRunStatus } from "./dashboard";
import {
  prepareDataOverview,
  recordFatalRunError,
  runProduction,
} from "./main";
import { validateOutput } from "./validate_output";

async function executeRun(): Promise<void> {
  try {
    await runProduction();
    updateRunStatus({ phase: "validating", currentMessageId: null });
    const archivePath = await validateOutput();
    updateRunStatus({ phase: "complete", archivePath });
    console.log("Run complete. Dashboard remains available for another run.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordFatalRunError(error);
    updateRunStatus({ phase: "failed", lastError: message });
    console.error("Run failed:", message);
  }
}

startDashboard(executeRun);
void prepareDataOverview().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  recordFatalRunError(error);
  updateRunStatus({ phase: "failed", lastError: message });
  console.error("Data overview failed:", message);
});
