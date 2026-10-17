export const operations = {
  click: "Click or activate a button, link or control",
  fill: "Type or replace text in an input or textarea",
  select: "Choose one option in a native dropdown/select",
  check: "Check a checkbox or select a radio button",
  uncheck: "Uncheck a checkbox",
  press: "Press an explicit keyboard key in a control",
  goto: "Navigate to an explicitly supplied URL or path",
  assert_text: "Verify that an exact literal text is visible on the page",
  assert_no_text:
    "Verify that an exact literal text is not visible on the page",
  assert_visible: "Verify that a described element is visible",
  assert_hidden: "Verify that a described element is hidden or absent",
  assert_value: "Verify the exact value of a form field",
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
  "assert_no_text",
  "assert_value",
  "assert_url",
]);
export const pageOperations = new Set<Operation>([
  "goto",
  "assert_url",
  "assert_text",
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
export interface DecisionProvider {
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
  href?: string;
  options?: string[];
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
  resolution?: "exact-label" | "jev";
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
  open(url: string): Promise<void>;
  observe(step?: CompiledStep): Promise<Observation>;
  execute(action: ResolvedAction): Promise<void>;
  prepare?(action: ResolvedAction): Promise<void>;
  refresh?(controlName?: string): Promise<void>;
  setInterruptionHandler?(handler: () => Promise<void>): void;
  capture(path: string): Promise<void>;
  close(): Promise<void>;
  diagnostics?(): PlatformDiagnostics;
}
export type CaseSpec = {
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
  index: number;
  text: string;
  status: "passed" | "failed" | "blocked";
  durationMs: number;
  action?: ResolvedAction;
  error?: string;
  screenshot?: string;
  phase?:
    | "compile"
    | "context"
    | "resolve"
    | "prepare"
    | "dispatch"
    | "assert"
    | "complete";
  category?: "configuration" | "environment" | "decision" | "ui" | "assertion";
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
  version: 1;
  name: string;
  mode: "live" | "replay" | "interactive";
  status: "passed" | "failed" | "blocked";
  startedAt: string;
  durationMs: number;
  steps: StepResult[];
  decisions: DecisionEvent[];
  error?: string;
  warnings: string[];
  interruptions?: Array<{
    name: string;
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
