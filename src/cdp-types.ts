/**
 * Chrome DevTools Protocol (CDP) & Comet MCP Server Type Definitions
 */

// ============================================================================
// 1. Target & Environment Types
// ============================================================================

export type TargetType = 
  | 'page' 
  | 'background_page' 
  | 'service_worker' 
  | 'other' 
  | 'iframe' 
  | 'sidecar';

export interface CDPTarget {
  id: string;
  type: TargetType | string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
  browserContextId?: string;
  /** True if the target is isolated in an Incognito context */
  isIncognito?: boolean;
}

export interface CDPVersion {
  Browser: string;
  "Protocol-Version": string;
  "User-Agent": string;
  "V8-Version": string;
  "WebKit-Version": string;
  webSocketDebuggerUrl: string;
}

export interface EnvironmentValidation {
  canUseSidecar: boolean;
  sidecarTargetId?: string;
  isIncognito: boolean;
  activeTab?: CDPTarget;
  reason?: string;
}

// ============================================================================
// 2. CDP Command & Evaluation Results
// ============================================================================

export interface NavigateResult {
  frameId: string;
  loaderId?: string;
  errorText?: string;
}

export interface ScreenshotResult {
  data: string; // Base64 encoded PNG/JPEG
}

export interface RemoteObject {
  type: 'object' | 'function' | 'undefined' | 'string' | 'number' | 'boolean' | 'bigint' | 'symbol';
  value?: unknown;
  description?: string;
  objectId?: string;
  className?: string;
}

export interface ExceptionDetails {
  text: string;
  lineNumber?: number;
  columnNumber?: number;
  scriptId?: string;
  url?: string;
  exception?: RemoteObject;
}

export interface EvaluateResult {
  result: RemoteObject;
  exceptionDetails?: ExceptionDetails;
}

// ============================================================================
// 3. Input & Coordinate Types
// ============================================================================

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElementCoordinates {
  x: number;
  y: number;
}

export interface ElementFingerprint {
  primarySelector: string;     // e.g., 'button[type="submit"]'
  role: string;                // e.g., 'button'
  accessibleName: string;      // e.g., 'Log In'
  parentAnchorText?: string;   // e.g., 'Account Sign In Form'
  nearText?: string[];         // e.g., ['Forgot Password?', 'Remember Me']
  expectedEffect: {
    type: 'url_change' | 'dom_mutation' | 'modal_open';
    targetValue?: string;
  };
  version: number;
  lastVerified: string;
}

export interface SmartClickOptions {
  selector?: string;
  coordinates?: ElementCoordinates;
  timeoutMs?: number;
  waitForNavigation?: boolean;
  fingerprint?: ElementFingerprint;
}

// ============================================================================
// 4. Session, Cookies & Network Interception
// ============================================================================

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface StorageSession {
  domain: string;
  cookies: Cookie[];
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
}

export interface InterceptedRequest {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  resourceType: string;
}

// ============================================================================
// 5. Accessibility & Semantic DOM
// ============================================================================

export interface AXValue {
  type: string;
  value?: unknown;
}

export interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  description?: AXValue;
  value?: AXValue;
  backendDOMNodeId?: number;
}

export interface AXTreeResult {
  nodes: AXNode[];
}

// ============================================================================
// 6. Comet Server State & Configuration
// ============================================================================

export interface CometState {
  connected: boolean;
  port: number;
  currentUrl?: string;
  activeTabId?: string;
  sidecarConnected: boolean;
  isIncognitoSession: boolean;
  lastError?: string;
}

export interface CometServerConfig {
  port: number;
  host: string;
  cometExecutablePath?: string;
  userDataDir?: string;
  autoDismissOverlays?: boolean;
}
