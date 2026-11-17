// The subset of the Codex 0.169.0 app-server protocol used by Discordex.
// Keep wire names aligned with `codex app-server generate-ts --experimental`.
export type RequestId = string | number;
// Images are snapshotted as data URLs before a Discord message enters the queue.
export interface InputImage { type: 'image'; url: string }
export type JsonObject = Record<string, any>;
export interface Packet {
  id?: RequestId;
  method?: string;
  params?: JsonObject;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}
export interface Thread {
  id: string;
  sessionId?: string;
  name?: string | null;
  cwd: string;
  parentThreadId?: string | null;
  agentNickname?: string | null;
  canAcceptDirectInput?: boolean | null;
  model?: string | null;
  reasoningEffort?: string | null;
  status: { type: string; activeFlags?: string[] };
  turns?: Turn[];
}
export interface Item extends JsonObject {
  id: string;
  type: string;
}
export interface Turn {
  id: string;
  status: 'inProgress' | 'completed' | 'interrupted' | 'failed';
  startedAt?: number | null;
  completedAt?: number | null;
  items?: Item[];
  error?: { message: string } | null;
}
export interface TurnState {
  turn: Turn;
  completedItemIds: string[];
  lastItemId: string | null;
  // A selected model is a snapshot of session settings, not execution telemetry.
  model?: { name: string; effort: string | null; source: 'selected' | 'rerouted' } | null;
}
export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}
export interface RateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  rateLimitReachedType?: string | null;
  spendControlReached?: boolean | null;
}
export interface AccountRateLimits {
  ordinaryUsageAllowed?: boolean | null;
  rateLimits?: RateLimitSnapshot | null;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot | undefined> | null;
}
export interface TokenUsageSnapshot {
  total: { totalTokens: number; inputTokens: number; outputTokens: number };
  reportedAt: number;
}
export type GoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';
export interface ThreadGoal {
  threadId: string;
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}
export interface GoalCardState {
  goal: ThreadGoal | null;
  version: string;
  epoch: string;
  unavailable?: string;
}
export interface Binding {
  threadId: string;
  parentThreadId: string | null;
  channelId: string;
  label: string;
  cwd: string;
  model?: string | null;
  reasoningEffort?: string | null;
  // Initial history boundary: a binding exports the active turn and future turns.
  since: number;
  initialTurnId: string | null;
  checkpoint: string | null;
}
export interface Button {
  id: string;
  label: string;
  danger?: boolean;
  style?: 'primary' | 'secondary' | 'success' | 'danger';
}
export interface Delivery {
  content: string;
  approvalReview?: { token: string; state: 'ready' | 'unavailable' };
  file?: { name: string; content: string; requiredForActions?: boolean };
  artifactRequest?: { cwd: string; references: string[] };
  artifacts?: Artifact[];
  artifactNotes?: string[];
  preserveReferences?: boolean;
  buttons?: Button[];
  card?: {
    title: string;
    subtitle?: string;
    tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
    compact?: boolean;
    hideHeader?: boolean;
    footer?: string;
  };
}
export interface Artifact {
  hash: string;
  name: string;
  kind: 'file' | 'image' | 'video';
  size: number;
  references?: string[];
}
export interface UploadFile extends Artifact { data: Buffer }
export interface UploadedFile { hash: string; name: string; id: string }
export interface DeliveryReceipt {
  approvalReview?: Delivery['approvalReview'];
  retryAttachments?: boolean;
}
export interface ChatPort {
  createThread(thread: Thread, replacingChannelId?: string): Promise<string>;
  checkThread(channelId: string): Promise<void>;
  send(channelId: string, delivery: Delivery, nonce: string): Promise<string | (DeliveryReceipt & { id: string })>;
  edit(channelId: string, messageId: string, delivery: Delivery): Promise<void | DeliveryReceipt>;
}
export interface CodexPort {
  readonly connected: boolean;
  readonly epoch: string;
  request<T = any>(method: string, params?: JsonObject): Promise<T>;
  respond(id: RequestId, result: unknown): Promise<void>;
  on(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
}
