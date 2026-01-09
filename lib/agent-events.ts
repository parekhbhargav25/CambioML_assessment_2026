import { ABORTED } from "@/lib/utils";

export type ToolName = "computer" | "bash" | "unknown";
export type ToolEventStatus = "running" | "success" | "error" | "aborted";

export type ComputerAction =
  | "screenshot"
  | "left_click"
  | "right_click"
  | "double_click"
  | "mouse_move"
  | "type"
  | "key"
  | "wait"
  | "scroll"
  | "unknown";

export type ComputerPayload = {
  toolName: "computer";
  action: ComputerAction;
  coordinate?: [number, number];
  text?: string;
  duration?: number;
  scroll_amount?: number;
  scroll_direction?: "up" | "down" | "left" | "right";
};

export type BashPayload = {
  toolName: "bash";
  command: string;
};

export type UnknownPayload = {
  toolName: "unknown";
  raw: Record<string, unknown>;
};

export type ToolPayload = ComputerPayload | BashPayload | UnknownPayload;

export type ToolResult =
  | { type: "text"; text: string }
  | { type: "image"; data: string }
  | { type: "aborted"; text: string }
  | { type: "unknown"; raw: unknown };

export type ToolEvent = {
  id: string;
  toolName: ToolName;
  timestamp: number;
  status: ToolEventStatus;
  durationMs?: number;
  payload: ToolPayload;
  result?: ToolResult;
};

export type EventState = {
  byId: Record<string, ToolEvent>;
  order: string[];
};

export type EventAction =
  | { type: "register-call"; event: ToolEvent }
  | {
      type: "register-result";
      id: string;
      status: ToolEventStatus;
      durationMs: number;
      result?: ToolResult;
    }
  | { type: "reset" };

export const initialEventState: EventState = {
  byId: {},
  order: [],
};

export function eventReducer(state: EventState, action: EventAction): EventState {
  switch (action.type) {
    case "register-call": {
      if (state.byId[action.event.id]) {
        return state;
      }
      return {
        byId: { ...state.byId, [action.event.id]: action.event },
        order: [...state.order, action.event.id],
      };
    }
    case "register-result": {
      const existing = state.byId[action.id];
      if (!existing) {
        const event: ToolEvent = {
          id: action.id,
          toolName: "unknown",
          timestamp: Date.now(),
          status: action.status,
          durationMs: action.durationMs,
          payload: { toolName: "unknown", raw: {} },
          result: action.result,
        };
        return {
          byId: { ...state.byId, [action.id]: event },
          order: [...state.order, action.id],
        };
      }
      return {
        ...state,
        byId: {
          ...state.byId,
          [action.id]: {
            ...existing,
            status: action.status,
            durationMs: action.durationMs,
            result: action.result ?? existing.result,
          },
        },
      };
    }
    case "reset":
      return initialEventState;
    default:
      return state;
  }
}

export function getEventType(event: ToolEvent): string {
  if (event.payload.toolName === "computer") {
    return `computer:${event.payload.action}`;
  }
  if (event.payload.toolName === "bash") {
    return "bash:command";
  }
  return "unknown";
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asCoordinate = (value: unknown): [number, number] | undefined => {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [x, y] = value;
  if (typeof x !== "number" || typeof y !== "number") return undefined;
  return [x, y];
};

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
};

export function parseToolPayload(
  toolName: string,
  args: unknown,
): ToolPayload {
  if (toolName === "bash") {
    const record = asRecord(args);
    const command = record ? asString(record.command) : undefined;
    return {
      toolName: "bash",
      command: command ?? "",
    };
  }

  if (toolName === "computer") {
    const record = asRecord(args) ?? {};
    const action = asString(record.action);
    return {
      toolName: "computer",
      action: (action as ComputerAction) ?? "unknown",
      coordinate: asCoordinate(record.coordinate),
      text: asString(record.text),
      duration: asNumber(record.duration),
      scroll_amount: asNumber(record.scroll_amount),
      scroll_direction: asString(record.scroll_direction) as
        | "up"
        | "down"
        | "left"
        | "right"
        | undefined,
    };
  }

  return {
    toolName: "unknown",
    raw: asRecord(args) ?? {},
  };
}

export function parseToolResult(result: unknown): ToolResult | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") {
    if (result === ABORTED) {
      return { type: "aborted", text: result };
    }
    return { type: "text", text: result };
  }
  const record = asRecord(result);
  if (record?.type === "image" && typeof record.data === "string") {
    return { type: "image", data: record.data };
  }
  if (record?.type === "text" && typeof record.text === "string") {
    if (record.text === ABORTED) {
      return { type: "aborted", text: record.text };
    }
    return { type: "text", text: record.text };
  }
  return { type: "unknown", raw: result };
}

export function deriveStatusFromResult(result: ToolResult | undefined): ToolEventStatus {
  if (!result) return "success";
  if (result.type === "aborted") return "aborted";
  return "success";
}
