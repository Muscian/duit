import type { PrivacyOptions, PrivacyPolicy } from "./privacy.js";
import type { FailureInfo, AgentReport } from "./failures.js";
import type { GenerateField, ContentOptions, FieldWriter } from "./content.js";
export const operations = {
  click: "Click or activate a button, link or control",
  fill: "Type or replace text in an input or textarea",
  select: "Choose one option in a native dropdown/select",
  check: "Check a checkbox or select a radio button",
  uncheck: "Uncheck a checkbox",
  press: "Press an explicit keyboard key in a control",
  goto: "Navigate to an explicitly supplied URL or path",
  assert_text_count: "Verify the exact number of visible literal text matches",
  assert_text: "Verify that an exact literal text is visible on the page",
  assert_no_text:
    "Verify that an exact literal text is not visible on the page",
  assert_visible: "Verify that a described element is visible",
  assert_hidden: "Verify that a described element is hidden or absent",
  assert_value: "Verify the exact value of a form field",
  assert_nonempty: "Verify a form field contains non-whitespace text",
  assert_checked: "Verify a checkbox/radio is checked",
  assert_unchecked: "Verify a checkbox/radio is unchecked",
  assert_enabled: "Verify a control is enabled",
  assert_disabled: "Verify a control is disabled",
  assert_url: "Verify the current URL equals an explicit URL or path",
  unsupported:
    "Compound step with multiple actions, vague goal, computation, visual judgement, or any unsupported operation",
} as const;
export type Operation = Exclude<keyof typeof operations, "unsupported">;
export const valueOperations = new Set<Operation>([
  "fill",
  "select",
  "press",
  "goto",
  "assert_text",
  "assert_text_count",
  "assert_no_text",
  "assert_value",
  "assert_url",
]);
export const pageOperations = new Set<Operation>([
  "goto",
  "assert_url",
  "assert_text",
  "assert_text_count",
  "assert_no_text",
]);
export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, unknown>;
};
export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};
export type DecisionResponse = {
  model: string;
  answers: Record<string, ChoiceAnswer>;
  usage: { input_tokens: number; output_tokens: number };
};
export type VisualFrame = {
  format: "png";
  dataBase64: string;
  width: number;
  height: number;
  revision: string;
  url?: string;
};
export type Box = { left: number; top: number; right: number; bottom: number };
export type VisualResponse = {
  model: string;
  answers: {
    presence: ChoiceAnswer;
    target: { type: "box"; box: Box; confidence: number };
  };
  usage: DecisionResponse["usage"];
};
export type VisualTarget = {
  box: Box;
  revision: string;
  width: number;
  height: number;
  confidence: number;
  presenceProbability: number;
};
export type VisualOptions = {
  enabled: boolean;
  minConfidence?: number;
  minProbability?: number;
  maxCalls?: number;
};
export type CostOptions = {
  maxRequests?: number;
  maxInputTokens?: number;
  maxUsd?: number;
  inputPerMillion?: number;
  outputPerMillion?: number;
};
export type UsageSummary = {
  requests: number;
  failedRequests: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number | null;
  pricingSource: string;
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  complete: boolean;
};
export interface DecisionProvider {
  locate?(
    frame: VisualFrame,
    instruction: string,
    signal?: AbortSignal,
  ): Promise<VisualResponse>;
  close?(): Promise<void>;
  decide(
    state: unknown,
    questions: Record<string, ChoiceQuestion>,
    signal?: AbortSignal,
  ): Promise<DecisionResponse>;
}
export type LocatorSpec = {
  frame: number;
  kind: "testId" | "label" | "role" | "css";
  value: string;
  name?: string;
};
export type ElementCandidate = {
  id: string;
  tag: string;
  role: string;
  name: string;
  text: string;
  type: string;
  disabled: boolean;
  visible: boolean;
  checked?: boolean;
  occluded?: boolean;
  blockedByModal?: boolean;
  overlay?: string;
  modal?: boolean;
  href?: string;
  options?: string[];
  placeholder?: string;
  context: string;
  locator: LocatorSpec;
};
export type Observation = {
  url: string;
  title: string;
  elements: ElementCandidate[];
  text?: string;
  dialogs?: string[];
};
export type AssertionWait = {
  timeoutMs: number;
  intervalMs?: number;
  refreshPage?: boolean;
  refreshControl?: string;
};
export type StepContext = { urlIncludes?: string; text?: string };
export type StepInstruction =
  | string
  | {
      instruction: string;
      operation?: Operation;
      count?: number;
      generate?: GenerateField;
      value?: string;
      control?: { name: string; role?: string };
      visual?: "fallback" | "only" | "off";
      context?: StepContext;
      scope?: string;
      aliases?: string[];
      wait?: AssertionWait;
    };
export type InterruptionRule = {
  name: string;
  when: { text: string; urlIncludes?: string };
  action: string;
  maxRuns?: number;
};
export type CompiledStep = {
  count?: number;
  literalValue?: boolean;
  generate?: GenerateField;
  control?: { name: string; role?: string };
  visual?: "fallback" | "only" | "off";
  wait?: AssertionWait;
  context?: StepContext;
  scope?: string;
  aliases?: string[];
  text: string;
  operation: Operation;
  value?: string;
};
export type ResolvedAction = CompiledStep & {
  target?: LocatorSpec;
  visualTarget?: VisualTarget;
  resolution?: "exact-label" | "unique-role" | "jev" | "jev-box";
};
export type PlatformDiagnostics = {
  url?: string;
  browser?: {
    name: string;
    version: string;
    channel?: string;
    localNetworkOrigins: string[];
  };
  connection?: { mode: "direct" | "proxy"; source: string; proxy?: string };
  events: Array<{
    kind:
      | "request_failed"
      | "http_error"
      | "navigation_blocked"
      | "browser_network_error";
    url: string;
    status?: number;
    message?: string;
    resourceType?: string;
    blockedReason?: string;
    corsError?: string;
  }>;
};
export interface PlatformAdapter {
  configurePrivacy?(policy: PrivacyPolicy): void;
  open(url: string): Promise<void>;
  observe(step?: CompiledStep): Promise<Observation>;
  observeVisual?(): Promise<VisualFrame>;
  execute(action: ResolvedAction): Promise<void>;
  prepare?(action: ResolvedAction): Promise<void>;
  refresh?(controlName?: string): Promise<void>;
  setInterruptionHandler?(handler: () => Promise<void>): void;
  capture(path: string): Promise<void>;
  close(): Promise<void>;
  diagnostics?(): PlatformDiagnostics;
}
export type InteractionOptions = {
  profile?: "manual" | "test";
  cookies?: "manual" | "accept" | "reject";
  onboarding?: "manual" | "dismiss";
  reminders?: "manual" | "later";
  unsavedChanges?: "manual" | "discard";
  maxActions?: number;
  exactLabelWaitMs?: number;
};
export type CaseSpec = {
  interaction?: InteractionOptions;
  decisionContext?: string;
  privacy?: PrivacyOptions;
  platform?: string;
  content?: ContentOptions;
  visual?: VisualOptions;
  costs?: CostOptions;
  name: string;
  baseUrl: string;
  steps: StepInstruction[];
  interruptions?: InterruptionRule[];
  cleanup?: StepInstruction[];
  publicVariables?: string[];
  browser?: {
    allowedOrigins?: string[];
    localNetworkOrigins?: string[];
    channel?: "chrome" | "chromium" | "msedge";
    timeoutMs?: number;
    navigationTimeoutMs?: number;
  };
  variables: Record<string, string>;
};
export type DecisionEvent = {
  phase: string;
  durationMs: number;
  request?: { state: unknown; questions: Record<string, ChoiceQuestion> };
  response: DecisionResponse;
};
export type StepResult = {
  assertionRecoveries?: Array<{ error: string; notices: string[] }>;
  failure?: FailureInfo;
  index: number;
  text: string;
  status: "passed" | "failed" | "blocked";
  durationMs: number;
  action?: ResolvedAction;
  error?: string;
  screenshot?: string;
  visualScreenshot?: string;
  phase?:
    | "compile"
    | "context"
    | "resolve"
    | "prepare"
    | "dispatch"
    | "assert"
    | "complete";
  category?: FailureInfo["category"] | "ui";
  recoveredBy?: number;
  retryOf?: number;
  pollAttempts?: number;
  evidence?: {
    url: string;
    title: string;
    text?: string;
    dialogs?: string[];
    controls: string[];
  };
};
export type RunReport = {
  privacy?: PrivacyPolicy;
  agent?: AgentReport;
  lifecycle?: "open" | "closed";
  cleanupExpected?: number;
  version: 1;
  name: string;
  mode: "live" | "replay" | "interactive";
  status: "passed" | "failed" | "blocked";
  startedAt: string;
  durationMs: number;
  steps: StepResult[];
  decisions: DecisionEvent[];
  visualDecisions?: Array<{
    instruction: string;
    revision: string;
    width: number;
    height: number;
    durationMs: number;
    response: VisualResponse;
  }>;
  usage?: UsageSummary;
  contentUsage?: FieldWriter["usage"];
  error?: string;
  warnings: string[];
  interruptions?: Array<{
    name: string;
    dispatched?: boolean;
    action: ResolvedAction;
    url: string;
    status: "passed" | "blocked";
    error?: string;
  }>;
  cleanup?: StepResult[];
  diagnostics?: PlatformDiagnostics;
  screenshot?: string;
  artifactsDir: string;
};
export class HarnessError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: "failed" | "blocked" = "blocked",
  ) {
    super(`${code}: ${message}`);
    this.name = "HarnessError";
  }
}
