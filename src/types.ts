// The subset of the Codex 0.169.0 app-server protocol used by Discordex.
// Keep wire names aligned with `codex app-server generate-ts --experimental`.
export type RequestId = string | number;
export type Verbosity = 'quiet' | 'progress' | 'verbose';
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
export interface Binding {
  threadId: string;
  parentThreadId: string | null;
  channelId: string;
  label: string;
  cwd: string;
  verbosity: Verbosity;
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
  file?: { name: string; content: string };
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
export interface ChatPort {
  createThread(thread: Thread): Promise<string>;
  send(channelId: string, delivery: Delivery, nonce: string): Promise<string>;
  edit(channelId: string, messageId: string, delivery: Delivery): Promise<void>;
}
export interface CodexPort {
  readonly connected: boolean;
  readonly epoch: string;
  request<T = any>(method: string, params?: JsonObject): Promise<T>;
  respond(id: RequestId, result: unknown): Promise<void>;
  on(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
}
