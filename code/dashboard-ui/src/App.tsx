import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  CardHeader,
  Icon,
  List,
  ListItemStandard,
  MessageStrip,
  ObjectStatus,
  ProgressIndicator,
  ShellBar,
  Tab,
  TabContainer,
  Text,
  Title,
} from "@ui5/webcomponents-react";

interface RunError {
  timestamp: string;
  messageIds: string[];
  attempt: number;
  recoverable: boolean;
  message: string;
}

interface RunStatus {
  phase: "idle" | "initializing" | "running" | "validating" | "complete" | "failed";
  processed: number;
  total: number;
  currentMessageId: string | null;
  model: string;
  rpm: number;
  lastError: string | null;
  errorHistory: RunError[];
  errorLogPath: string | null;
  archivePath: string | null;
  dataInsights: Record<string, number>;
  inputStats: {
    conversationTypes: Record<string, number>;
    mediaTypes: Record<string, number>;
  };
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

const initialStatus: RunStatus = {
  phase: "idle",
  processed: 0,
  total: 0,
  currentMessageId: null,
  model: "—",
  rpm: 0,
  lastError: null,
  errorHistory: [],
  errorLogPath: null,
  archivePath: null,
  dataInsights: {},
  inputStats: { conversationTypes: {}, mediaTypes: {} },
  outputStats: { actions: {}, messageTypes: {}, averageConfidence: 0 },
  lastDecision: null,
};

function phaseState(phase: RunStatus["phase"]): "Positive" | "Negative" | "Information" | "None" {
  if (phase === "complete") return "Positive";
  if (phase === "failed") return "Negative";
  if (["running", "validating", "initializing"].includes(phase)) return "Information";
  return "None";
}

function Distribution({ values }: { values: Record<string, number> }) {
  const entries = Object.entries(values).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return <Text>Pending</Text>;
  return (
    <div className="distribution">
      {entries.map(([label, count]) => (
        <div className="distributionRow" key={label}>
          <Text>{label.replace(/_/g, " ")}</Text>
          <ObjectStatus inverted state="Information">{count}</ObjectStatus>
        </div>
      ))}
    </div>
  );
}

function MetricCard({ title, value, subtitle, icon = "business-objects-experience" }: { title: string; value: string; subtitle?: string; icon?: string }) {
  return (
    <Card className="metricCard" accessibleName={title} header={<CardHeader titleText={title} subtitleText={subtitle} />}>
      <div className="metricCardBody">
        <span className="metricIcon" aria-hidden="true"><Icon name={icon} /></span>
        <div className="metricValue">{value}</div>
      </div>
    </Card>
  );
}

function PageHeading({ title, description, status, state = "Information" }: { title: string; description: string; status: string; state?: "Positive" | "Negative" | "Information" | "None" }) {
  return (
    <div className="pageHeading">
      <div className="pageHeadingText"><Title level="H2">{title}</Title><Text>{description}</Text></div>
      <ObjectStatus showDefaultIcon state={state}>{status}</ObjectStatus>
    </div>
  );
}

function OverviewTab({ status }: { status: RunStatus }) {
  return (
    <div className="tabContent">
      <PageHeading title="Dataset overview" description="Explore the indexed source data before starting an AI classification run." status="Read only" />
      <section className="metricGrid insightGrid">
        {Object.entries(status.dataInsights).map(([name, value], index) => (
          <MetricCard key={name} title={name.replace(/_/g, " ")} value={String(value)} icon={["database", "group", "message-information", "picture"][index % 4]} />
        ))}
      </section>
      <section className="twoColumnGrid">
        <Card accessibleName="Conversation types" header={<CardHeader titleText="Conversation types" />}>
          <div className="cardContent"><Distribution values={status.inputStats.conversationTypes} /></div>
        </Card>
        <Card accessibleName="Media types" header={<CardHeader titleText="Media types" />}>
          <div className="cardContent"><Distribution values={status.inputStats.mediaTypes} /></div>
        </Card>
      </section>
    </div>
  );
}

function RunTab({ status, onRun, starting }: { status: RunStatus; onRun: () => void; starting: boolean }) {
  const active = ["initializing", "running", "validating"].includes(status.phase);
  const progress = status.total ? (status.processed / status.total) * 100 : 0;
  const errors = [...status.errorHistory].reverse();
  return (
    <div className="tabContent">
      <div className="runToolbar pageHeading">
        <div className="pageHeadingText"><Title level="H2">Run control</Title><Text>Start and monitor a guarded notification-routing run.</Text></div>
        <Button design="Emphasized" disabled={active || starting} loading={starting} onClick={onRun}>
          {active ? "Run active" : "Start run"}
        </Button>
      </div>
      <section className="metricGrid">
        <MetricCard title="Progress" value={`${status.processed} / ${status.total}`} icon="process" />
        <MetricCard title="Model" value={status.model} icon="machine" />
        <MetricCard title="RPM cap" value={String(status.rpm)} icon="performance" />
        <MetricCard title="Current batch" value={status.currentMessageId ?? "—"} icon="pending" />
      </section>
      <Card accessibleName="Completion" header={<CardHeader titleText="Completion" />}>
        <div className="cardContent"><ProgressIndicator value={progress} displayValue={`${progress.toFixed(1)}%`} /></div>
      </Card>
      <section className="twoColumnGrid">
        <Card accessibleName="Actions" header={<CardHeader titleText="Actions" />}>
          <div className="cardContent"><Distribution values={status.outputStats.actions} /></div>
        </Card>
        <Card accessibleName="Message categories" header={<CardHeader titleText="Message categories" />}>
          <div className="cardContent"><Distribution values={status.outputStats.messageTypes} /></div>
        </Card>
        <MetricCard title="Average confidence" value={status.outputStats.averageConfidence.toFixed(3)} />
        <MetricCard
          title="Latest decision"
          value={status.lastDecision ? `${status.lastDecision.action} · ${status.lastDecision.messageType}` : "Pending"}
          subtitle={status.lastDecision?.messageId}
        />
      </section>
      <Card
        accessibleName="Runtime errors"
        header={<CardHeader titleText="Runtime errors" subtitleText={status.errorLogPath ?? "No persistent log yet"} additionalText={String(errors.length)} />}
      >
        {errors.length ? (
          <List>
            {errors.map((error, index) => (
              <ListItemStandard
                key={`${error.timestamp}-${index}`}
                text={error.message}
                description={`${new Date(error.timestamp).toLocaleTimeString()} · ${error.messageIds.join(", ") || "run"}`}
                additionalText={`attempt ${error.attempt}`}
                additionalTextState={error.recoverable ? "Information" : "Negative"}
                wrappingType="Normal"
              />
            ))}
          </List>
        ) : <div className="cardContent"><ObjectStatus state="Positive">No errors recorded</ObjectStatus></div>}
      </Card>
      <Card accessibleName="Archived output" header={<CardHeader titleText="Archived output" />}>
        <div className="cardContent"><Text>{status.archivePath ?? "Pending"}</Text></div>
      </Card>
    </div>
  );
}

function WorkflowTab() {
  const steps = [
    ["1. Index", "CSV relationships become typed in-memory maps keyed by user, channel, business, and media ID."],
    ["2. Retrieve", "Historical messages are ranked instead of copied wholesale into the prompt."],
    ["3. Enrich", "User preferences, group membership, business trust, interactions, notification load, and media are joined."],
    ["4. Batch", "Ten enriched messages share one multimodal Gemini request with strict message-ID correlation."],
    ["5. Validate", "Zod, evidence-ID, count, duplicate, confidence, and schema checks run before output promotion."],
  ];
  return (
    <div className="tabContent">
      <PageHeading title="Implementation workflow" description="See how relational context becomes a validated routing decision." status="5 stages" />
      <MessageStrip design="Information">
        Retrieval score = 0.45 × lexical similarity + 0.30 × recency + 0.25 × interaction strength.
      </MessageStrip>
      <section className="workflowGrid">
        {steps.map(([title, description]) => (
          <Card key={title} accessibleName={title} header={<CardHeader titleText={title} />}>
            <div className="cardContent"><Text>{description}</Text></div>
          </Card>
        ))}
      </section>
      <Card accessibleName="Mathematical context selection" header={<CardHeader titleText="Mathematical context selection" />}>
        <div className="cardContent formulaBlock">
          <Text><strong>Lexical similarity:</strong> Jaccard intersection-over-union of normalized message tokens.</Text>
          <Text><strong>Recency:</strong> exponential decay exp(−ageDays / 30).</Text>
          <Text><strong>Interaction:</strong> weighted opens, replies, dismissals, mutes, and reports.</Text>
          <Text><strong>Result:</strong> only the top five channel-specific records are sent as evidence, reducing tokens and latency.</Text>
        </div>
      </Card>
    </div>
  );
}

export function App() {
  const [status, setStatus] = useState(initialStatus);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch("/api/status", { cache: "no-store" });
        if (!response.ok) throw new Error(`Status API returned ${response.status}`);
        const next = (await response.json()) as RunStatus;
        if (active) { setStatus(next); setConnectionError(null); setStarting(false); }
      } catch (error) {
        if (active) setConnectionError(error instanceof Error ? error.message : String(error));
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 1_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const startRun = async () => {
    setStarting(true);
    try {
      const response = await fetch("/api/run", { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error));
      setStarting(false);
    }
  };

  const statusLabel = useMemo(() => status.phase, [status.phase]);
  return (
    <div className="appShell">
      <ShellBar
        primaryTitle="Message Notification Router"
        secondaryTitle="HackerRank Orchestrate"
        content={(
          <ObjectStatus inverted showDefaultIcon state={phaseState(status.phase)}>
            {statusLabel}
          </ObjectStatus>
        )}
      />
      {connectionError && <MessageStrip design="Negative">{connectionError}</MessageStrip>}
      {status.lastError && <MessageStrip design="Critical">{status.lastError}</MessageStrip>}
      <TabContainer contentBackgroundDesign="Transparent">
        <Tab icon="database" text="Data Overview" selected><OverviewTab status={status} /></Tab>
        <Tab icon="process" text="Run Control"><RunTab status={status} onRun={startRun} starting={starting} /></Tab>
        <Tab icon="workflow-tasks" text="Implementation Workflow"><WorkflowTab /></Tab>
      </TabContainer>
    </div>
  );
}
