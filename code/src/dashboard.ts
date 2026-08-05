import * as fs from "fs";
import * as http from "http";
import * as path from "path";

export interface RunError {
  timestamp: string;
  messageIds: string[];
  attempt: number;
  recoverable: boolean;
  message: string;
}

export interface RunStatus {
  phase: "idle" | "initializing" | "running" | "validating" | "complete" | "failed";
  processed: number;
  total: number;
  currentMessageId: string | null;
  model: string;
  rpm: number;
  startedAt: string | null;
  updatedAt: string;
  lastError: string | null;
  errorHistory: RunError[];
  errorLogPath: string | null;
  archivePath: string | null;
  dashboardPort: number;
  inputStats: {
    conversationTypes: Record<string, number>;
    mediaTypes: Record<string, number>;
  };
  dataInsights: Record<string, number>;
  outputStats: {
    actions: Record<string, number>;
    messageTypes: Record<string, number>;
    averageConfidence: number;
  };
  lastDecision: {
    messageId: string;
    action: string;
    messageType: string;
    confidence: number;
  } | null;
}

const status: RunStatus = {
  phase: "idle",
  processed: 0,
  total: 0,
  currentMessageId: null,
  model: process.env.GEMINI_MODEL ?? "gemini-3.6-flash",
  rpm: Math.floor(60_000 / Number(process.env.GEMINI_MIN_INTERVAL_MS ?? "15000")),
  startedAt: null,
  updatedAt: new Date().toISOString(),
  lastError: null,
  errorHistory: [],
  errorLogPath: null,
  archivePath: null,
  dashboardPort: Number(process.env.DASHBOARD_PORT ?? "3000"),
  inputStats: { conversationTypes: {}, mediaTypes: {} },
  dataInsights: {},
  outputStats: { actions: {}, messageTypes: {}, averageConfidence: 0 },
  lastDecision: null,
};

const dashboardDist = path.resolve(__dirname, "../dashboard-dist");
const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export function updateRunStatus(update: Partial<RunStatus>): void {
  Object.assign(status, update, { updatedAt: new Date().toISOString() });
}

export function appendRunError(error: RunError): void {
  status.errorHistory = [...status.errorHistory, error].slice(-50);
  updateRunStatus({ lastError: error.message });
}

function serveDashboard(requestPath: string, response: http.ServerResponse): void {
  const normalized = requestPath === "/" ? "/index.html" : requestPath;
  const relativePath = decodeURIComponent(normalized).replace(/^\/+/, "");
  const filePath = path.resolve(dashboardDist, relativePath);
  const relativeToDist = path.relative(dashboardDist, filePath);

  if (relativeToDist.startsWith("..") || path.isAbsolute(relativeToDist)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response
      .writeHead(503, { "Content-Type": "text/plain; charset=utf-8" })
      .end("Dashboard bundle is missing. Run npm run build:dashboard.");
    return;
  }

  response.writeHead(200, {
    "Content-Type": contentTypes[path.extname(filePath)] ?? "application/octet-stream",
    "Cache-Control": filePath.endsWith("index.html") ? "no-store" : "public, max-age=31536000",
  });
  fs.createReadStream(filePath).pipe(response);
}

export function startDashboard(onRun?: () => Promise<void>): http.Server {
  let port = Number(process.env.DASHBOARD_PORT ?? "3000");
  let portAttempts = 0;
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (requestUrl.pathname === "/api/status") {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(status));
      return;
    }
    if (requestUrl.pathname === "/api/run" && request.method === "POST") {
      if (!onRun) {
        response.writeHead(501).end("Run control is unavailable.");
        return;
      }
      if (["initializing", "running", "validating"].includes(status.phase)) {
        response.writeHead(409).end("A run is already active.");
        return;
      }
      response.writeHead(202, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ accepted: true }));
      void onRun();
      return;
    }
    serveDashboard(requestUrl.pathname, response);
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE" && portAttempts < 10) {
      port += 1;
      portAttempts += 1;
      console.warn(`Dashboard port busy; trying http://localhost:${port}`);
      server.listen(port, "127.0.0.1");
      return;
    }
    console.error("Dashboard server failed:", error.message);
    updateRunStatus({ phase: "failed", lastError: error.message });
  });
  server.listen(port, "127.0.0.1", () => {
    updateRunStatus({ dashboardPort: port });
    console.log(`Dashboard: http://localhost:${port}`);
  });
  return server;
}
