export type PermissionMode = "ask" | "auto" | "bypass";

export type CliOptions = {
  cwd: string;
  provider: string;
  model: string;
  print: boolean;
  json: boolean;
  resume?: string;
  session?: string;
  permissionMode: PermissionMode;
  maxReadBytes: number;
};

export type ToolEnvironment = {
  cwd: string;
  maxReadBytes: number;
};

export type SessionRecord =
  | {
      type: "meta";
      sessionId: string;
      cwd: string;
      provider: string;
      model: string;
      createdAt: string;
    }
  | {
      type: "event";
      at: string;
      event: unknown;
    }
  | {
      type: "user";
      at: string;
      content: string;
    }
  | {
      type: "snapshot";
      at: string;
      messages: unknown[];
    };
