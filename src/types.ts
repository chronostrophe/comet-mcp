// Type definitions for CDP client and Comet MCP Server

export interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
  browserContextId?: string;
}

export interface CDPVersion {
  Browser: string;
  "Protocol-Version": string;
  "User-Agent": string;
  "V8-Version": string;
  "WebKit-Version": string;
  webSocketDebuggerUrl: string;
}

export interface NavigateResult {
  frameId: string;
  loaderId?: string;
  errorText?: string;
}

export interface ScreenshotResult {
  data: string; // Base64 encoded
}

export interface EvaluateResult {
  result: {
    type: string;
    value?: unknown;
    description?: string;
    objectId?: string;
  };
  exceptionDetails?: {
    text: string;
    exception?: {
      description?: string;
    };
  };
}

export interface CometState {
  connected: boolean;
  port: number;
  currentUrl?: string;
  activeTabId?: string;
}
