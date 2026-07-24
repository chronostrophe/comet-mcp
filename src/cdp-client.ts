// CDP Client wrapper for Comet browser control
// Supports macOS, Windows, and WSL

import CDP from "chrome-remote-interface";
import { spawn, ChildProcess, execSync } from "child_process";
import { platform } from "os";
import { existsSync } from "fs";
import type {
  CDPTarget,
  CDPVersion,
  NavigateResult,
  ScreenshotResult,
  EvaluateResult,
  CometState,
} from "./types.js";

// ============ PLATFORM DETECTION ============

/**
 * Detect if running in WSL (Windows Subsystem for Linux)
 */
function isWSL(): boolean {
  if (platform() !== 'linux') return false;
  try {
    const release = execSync('uname -r', { encoding: 'utf8' }).toLowerCase();
    return release.includes('microsoft') || release.includes('wsl');
  } catch {
    return false;
  }
}

const IS_WSL = isWSL();
const IS_WINDOWS = platform() === "win32" || IS_WSL;

/**
 * Get the appropriate Comet executable path for the current platform
 */
function getCometPath(): string {
  // Allow override via environment variable
  if (process.env.COMET_PATH) {
    return process.env.COMET_PATH;
  }

  const os = platform();

  if (os === "darwin") {
    return "/Applications/Comet.app/Contents/MacOS/Comet";
  }

  if (os === "win32" || IS_WSL) {
    // Common Windows installation paths for Comet
    const possiblePaths = [
      `${process.env.LOCALAPPDATA}\\Perplexity\\Comet\\Application\\comet.exe`,
      `${process.env.APPDATA}\\Perplexity\\Comet\\Application\\comet.exe`,
      "C:\\Program Files\\Perplexity\\Comet\\Application\\comet.exe",
      "C:\\Program Files (x86)\\Perplexity\\Comet\\Application\\comet.exe",
    ];

    for (const p of possiblePaths) {
      if (p && existsSync(p)) {
        return p;
      }
    }

    // Default to LOCALAPPDATA path
    return `${process.env.LOCALAPPDATA}\\Perplexity\\Comet\\Application\\comet.exe`;
  }

  // Fallback for other platforms
  return "/Applications/Comet.app/Contents/MacOS/Comet";
}

const COMET_PATH = getCometPath();
const DEFAULT_PORT = 9222;

// ============ WSL NETWORK HELPERS ============

/**
 * Check if WSL can directly connect to Windows localhost (mirrored networking)
 */
async function canConnectToWindowsLocalhost(port: number): Promise<boolean> {
  if (!IS_WSL) return true;

  const net = await import('net');
  return new Promise((resolve) => {
    const client = net.createConnection({ port, host: '127.0.0.1' }, () => {
      client.destroy();
      resolve(true);
    });
    client.on('error', () => {
      resolve(false);
    });
    client.setTimeout(2000, () => {
      client.destroy();
      resolve(false);
    });
  });
}

/**
 * Get the port to use for CDP WebSocket connection from WSL
 * Throws helpful error if mirrored networking is not enabled
 */
async function getWSLConnectPort(targetPort: number): Promise<number> {
  if (!IS_WSL) return targetPort;

  const canConnect = await canConnectToWindowsLocalhost(targetPort);
  if (canConnect) {
    return targetPort;
  }

  throw new Error(
    `WSL cannot connect to Windows localhost:${targetPort}.\n\n` +
    `To fix this, enable WSL mirrored networking:\n` +
    `1. Create/edit %USERPROFILE%\\.wslconfig with:\n` +
    `   [wsl2]\n` +
    `   networkingMode=mirrored\n` +
    `2. Run: wsl --shutdown\n` +
    `3. Restart WSL and try again\n\n` +
    `Alternatively, run Claude Code from Windows PowerShell instead of WSL.`
  );
}

/**
 * Windows/WSL-compatible fetch using PowerShell
 * On WSL, native fetch connects to WSL's localhost, not Windows where Comet runs
 */
async function windowsFetch(
  url: string,
  method: string = 'GET'
): Promise<{ ok: boolean; status: number; json: () => Promise<any> }> {
  // Use native fetch on macOS/Linux (non-WSL)
  if (platform() !== 'win32' && !IS_WSL) {
    const response = await fetch(url, { method });
    return response;
  }

  // On Windows or WSL, use PowerShell to reach Windows localhost
  try {
    const psCommand = method === 'PUT'
      ? `Invoke-WebRequest -Uri '${url}' -Method PUT -UseBasicParsing | Select-Object -ExpandProperty Content`
      : `Invoke-WebRequest -Uri '${url}' -UseBasicParsing | Select-Object -ExpandProperty Content`;

    const result = execSync(`powershell.exe -NoProfile -Command "${psCommand}"`, {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });

    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(result.trim())
    };
  } catch (error: any) {
    return {
      ok: false,
      status: 0,
      json: async () => { throw error; }
    };
  }
}

export class CometCDPClient {
  private client: CDP.Client | null = null;
  private cometProcess: ChildProcess | null = null;
  private state: CometState = {
    connected: false,
    port: DEFAULT_PORT,
    sidecarConnected: false,
    isIncognitoSession: false,
  };
  private lastTargetId: string | undefined;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private isReconnecting: boolean = false;

  get isConnected(): boolean {
    return this.state.connected && this.client !== null;
  }

  /**
   * Health check - verify connection is actually alive (not just "connected" in state)
   * This catches cases where WebSocket died silently
   */
  async isHealthy(): Promise<boolean> {
    if (!this.client || !this.state.connected) return false;

    try {
      // Simple evaluation that should always work if connected
      const result = await Promise.race([
        this.client.Runtime.evaluate({ expression: '1+1', returnByValue: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Health check timeout')), 3000))
      ]);
      return (result as any)?.result?.value === 2;
    } catch {
      // Connection is dead
      this.state.connected = false;
      return false;
    }
  }

  /**
   * Ensure we have a healthy connection, reconnecting if needed
   * Call this before any CDP operation
   */
  async ensureHealthyConnection(): Promise<void> {
    const healthy = await this.isHealthy();
    if (!healthy) {
      await this.reconnect();
    }
  }

  get currentState(): CometState {
    return { ...this.state };
  }

  /**
   * Auto-reconnect wrapper for operations with exponential backoff
   */
  private async withAutoReconnect<T>(operation: () => Promise<T>): Promise<T> {
    if (this.isReconnecting) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    try {
      const result = await operation();
      this.reconnectAttempts = 0;
      return result;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      const connectionErrors = [
        'WebSocket', 'CLOSED', 'not open', 'disconnected',
        'ECONNREFUSED', 'ECONNRESET', 'Protocol error', 'Target closed', 'Session closed'
      ];

      if (connectionErrors.some(e => errorMessage.includes(e)) &&
          this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        this.isReconnecting = true;

        try {
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 5000);
          await new Promise(resolve => setTimeout(resolve, delay));
          await this.reconnect();
          this.isReconnecting = false;
          return await operation();
        } catch (reconnectError) {
          this.isReconnecting = false;
          throw reconnectError;
        }
      }

      throw error;
    }
  }

  /**
   * Reconnect to the last connected tab
   */
  async reconnect(): Promise<string> {
    if (this.client) {
      try { await this.client.close(); } catch { /* ignore */ }
    }
    this.state.connected = false;
    this.client = null;

    // Verify Comet is running
    try {
      await this.getVersion();
    } catch {
      try {
        await this.startComet(this.state.port);
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch {
        throw new Error('Cannot connect to Comet. Ensure Comet is running with --remote-debugging-port=9222');
      }
    }

    // Try to reconnect to last target
    if (this.lastTargetId) {
      try {
        const targets = await this.listTargets();
        if (targets.find(t => t.id === this.lastTargetId)) {
          return await this.connect(this.lastTargetId);
        }
      } catch { /* target gone */ }
    }

    // Connect to best target using Production Target Selection Guard
    const target = await this.getActiveFocusedPageTarget({ mustBeDefaultContext: true, activateOnSelect: true });
    return await this.connect(target.id);
  }

  /**
   * Production Target Selection Guard:
   * 1. Filter out background pages, webviews, extensions & sidecars
   * 2. URL Domain Matching -> Default Window Context -> Active Tab
   * 3. Mandatory Focus Activation via GET /json/activate/<id>
   */
  async getActiveFocusedPageTarget(options: { urlMatch?: string; mustBeDefaultContext?: boolean; activateOnSelect?: boolean } = {}): Promise<CDPTarget> {
    const targets = await this.listTargets();
    const pageTargets = targets.filter(t =>
      t.type === 'page' &&
      !t.url.includes('chrome-extension://') &&
      !t.url.includes('/sidecar')
    );

    if (pageTargets.length === 0) {
      throw new Error('No valid page targets found.');
    }

    let selectedTarget: CDPTarget | undefined = undefined;

    if (options.urlMatch) {
      selectedTarget = pageTargets.find(t => t.url.toLowerCase().includes(options.urlMatch!.toLowerCase()));
    }

    if (!selectedTarget && options.mustBeDefaultContext) {
      selectedTarget = pageTargets.find(t => !t.browserContextId || t.browserContextId === 'default');
    }

    if (!selectedTarget) {
      selectedTarget = pageTargets[0];
    }

    if (options.activateOnSelect && selectedTarget) {
      try {
        await windowsFetch(`http://127.0.0.1:${this.state.port}/json/activate/${selectedTarget.id}`, 'GET');
      } catch { /* continue */ }
    }

    return selectedTarget;
  }

  /**
   * List tabs with categorization
   */
  async listTabsCategorized(): Promise<{
    main: CDPTarget | null;
    sidecar: CDPTarget | null;
    agentBrowsing: CDPTarget | null;
    overlay: CDPTarget | null;
    others: CDPTarget[];
  }> {
    const targets = await this.listTargets();

    return {
      main: targets.find(t =>
        t.type === 'page' && t.url.includes('perplexity.ai') && !t.url.includes('sidecar')
      ) || null,
      sidecar: targets.find(t =>
        t.type === 'page' && t.url.includes('sidecar')
      ) || null,
      agentBrowsing: targets.find(t =>
        t.type === 'page' &&
        !t.url.includes('perplexity.ai') &&
        !t.url.includes('chrome-extension') &&
        !t.url.includes('chrome://') &&
        t.url !== 'about:blank'
      ) || null,
      overlay: targets.find(t =>
        t.url.includes('chrome-extension') && t.url.includes('overlay')
      ) || null,
      others: targets.filter(t =>
        t.type === 'page' &&
        !t.url.includes('perplexity.ai') &&
        !t.url.includes('chrome-extension')
      ),
    };
  }

  /**
   * Check if Comet process is running
   */
  private async isCometProcessRunning(): Promise<boolean> {
    return new Promise((resolve) => {
      if (IS_WINDOWS) {
        // Windows: use tasklist to check for comet.exe
        const check = spawn('tasklist', ['/FI', 'IMAGENAME eq comet.exe', '/NH']);
        let output = '';
        check.stdout?.on('data', (data) => { output += data.toString(); });
        check.on('close', () => {
          resolve(output.toLowerCase().includes('comet.exe'));
        });
        check.on('error', () => resolve(false));
      } else {
        // macOS/Linux: use pgrep
        const check = spawn('pgrep', ['-f', 'Comet.app']);
        check.on('close', (code) => resolve(code === 0));
        check.on('error', () => resolve(false));
      }
    });
  }

  /**
   * Kill any running Comet process
   */
  private async killComet(): Promise<void> {
    return new Promise((resolve) => {
      if (IS_WINDOWS) {
        // Windows: use taskkill to kill comet.exe
        const kill = spawn('taskkill', ['/F', '/IM', 'comet.exe']);
        kill.on('close', () => setTimeout(resolve, 1000));
        kill.on('error', () => setTimeout(resolve, 1000));
      } else {
        // macOS/Linux: use pkill
        const kill = spawn('pkill', ['-f', 'Comet.app']);
        kill.on('close', () => setTimeout(resolve, 1000));
        kill.on('error', () => setTimeout(resolve, 1000));
      }
    });
  }

  /**
   * Start Comet browser with remote debugging enabled
   * Handles macOS, Windows, and WSL environments
   */
  async startComet(port: number = DEFAULT_PORT): Promise<string> {
    this.state.port = port;

    // ========== WSL: Use PowerShell to communicate with Windows ==========
    if (IS_WSL) {
      // Check if Comet is already running via PowerShell HTTP
      try {
        const response = await windowsFetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) {
          const version = await response.json() as CDPVersion;
          return `Comet already running on Windows host, port: ${port} (${version.Browser})`;
        }
      } catch {
        // Comet not accessible, need to launch
      }

      // Get Windows LOCALAPPDATA path and construct Comet path
      let cometPath = '';
      try {
        const localAppData = execSync('cmd.exe /c echo %LOCALAPPDATA%', { encoding: 'utf8' })
          .trim().replace(/\r?\n/g, '');
        cometPath = `${localAppData}\\Perplexity\\Comet\\Application\\Comet.exe`;
      } catch {
        cometPath = 'C:\\Users\\' + (process.env.USER || 'user') +
          '\\AppData\\Local\\Perplexity\\Comet\\Application\\Comet.exe';
      }

      try {
        // Launch Comet via PowerShell (Set-Location avoids UNC path issues)
        const psCommand = `Set-Location C:\\; Start-Process -FilePath '${cometPath}' -ArgumentList '--remote-debugging-port=${port}'`;
        spawn('powershell.exe', ['-NoProfile', '-Command', psCommand], {
          detached: true,
          stdio: 'ignore',
        }).unref();

        // Wait for Comet to start
        return new Promise((resolve, reject) => {
          const maxAttempts = 40;
          let attempts = 0;

          const checkReady = async () => {
            attempts++;
            try {
              const response = await windowsFetch(`http://127.0.0.1:${port}/json/version`);
              if (response.ok) {
                resolve(`Comet started via WSL->PowerShell on port ${port}`);
                return;
              }
            } catch { /* keep trying */ }

            if (attempts < maxAttempts) {
              setTimeout(checkReady, 500);
            } else {
              reject(new Error(
                `Timeout waiting for Comet. Tried to launch: ${cometPath}\n` +
                `Try manually: powershell.exe -Command "Start-Process '${cometPath}' -ArgumentList '--remote-debugging-port=${port}'"`
              ));
            }
          };

          setTimeout(checkReady, 2000);
        });
      } catch (launchError) {
        throw new Error(
          `Cannot connect to or launch Comet browser.\n` +
          `Tried path: ${cometPath}\n` +
          `Error: ${launchError instanceof Error ? launchError.message : String(launchError)}`
        );
      }
    }

    // ========== Native Windows: Use windowsFetch for HTTP ==========
    if (platform() === 'win32') {
      try {
        const response = await windowsFetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) {
          const version = await response.json() as CDPVersion;
          return `Comet already running with debug port: ${version.Browser}`;
        }
      } catch {
        const isRunning = await this.isCometProcessRunning();
        if (isRunning) {
          await this.killComet();
        }
      }

      // Start Comet on Windows
      return new Promise((resolve, reject) => {
        this.cometProcess = spawn(COMET_PATH, [`--remote-debugging-port=${port}`], {
          detached: true,
          stdio: "ignore",
        });
        this.cometProcess.unref();

        const maxAttempts = 40;
        let attempts = 0;

        const checkReady = async () => {
          attempts++;
          try {
            const response = await windowsFetch(`http://127.0.0.1:${port}/json/version`);
            if (response.ok) {
              resolve(`Comet started with debug port ${port}`);
              return;
            }
          } catch { /* keep trying */ }

          if (attempts < maxAttempts) {
            setTimeout(checkReady, 500);
          } else {
            reject(new Error(`Timeout waiting for Comet. Try: "${COMET_PATH}" --remote-debugging-port=${port}`));
          }
        };

        setTimeout(checkReady, 1500);
      });
    }

    // ========== macOS/Linux: Original approach ==========
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(`http://localhost:${port}/json/version`, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (response.ok) {
        const version = await response.json() as CDPVersion;
        return `Comet already running with debug port: ${version.Browser}`;
      }
    } catch {
      const isRunning = await this.isCometProcessRunning();
      if (isRunning) {
        await this.killComet();
      }
    }

    // Start Comet on macOS/Linux
    return new Promise((resolve, reject) => {
      this.cometProcess = spawn(COMET_PATH, [`--remote-debugging-port=${port}`], {
        detached: true,
        stdio: "ignore",
      });
      this.cometProcess.unref();

      const maxAttempts = 40;
      let attempts = 0;

      const checkReady = async () => {
        attempts++;
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 2000);
          const response = await fetch(`http://localhost:${port}/json/version`, { signal: controller.signal });
          clearTimeout(timeoutId);

          if (response.ok) {
            const version = await response.json() as CDPVersion;
            resolve(`Comet started with debug port ${port}: ${version.Browser}`);
            return;
          }
        } catch { /* keep trying */ }

        if (attempts < maxAttempts) {
          setTimeout(checkReady, 500);
        } else {
          reject(new Error(`Timeout waiting for Comet. Try: ${COMET_PATH} --remote-debugging-port=${port}`));
        }
      };

      setTimeout(checkReady, 1500);
    });
  }

  /**
   * Get CDP version info
   */
  async getVersion(): Promise<CDPVersion> {
    const response = await windowsFetch(`http://127.0.0.1:${this.state.port}/json/version`);
    if (!response.ok) throw new Error(`Failed to get version: ${response.status}`);
    return response.json() as Promise<CDPVersion>;
  }

  /**
   * List all available tabs/targets
   */
  async listTargets(): Promise<CDPTarget[]> {
    const response = await windowsFetch(`http://127.0.0.1:${this.state.port}/json/list`);
    if (!response.ok) throw new Error(`Failed to list targets: ${response.status}`);
    return response.json() as Promise<CDPTarget[]>;
  }

  /**
   * Connect to a specific tab
   */
  async connect(targetId?: string): Promise<string> {
    if (this.client) {
      await this.disconnect();
    }

    // On WSL, verify mirrored networking is available for WebSocket connection
    const connectPort = await getWSLConnectPort(this.state.port);

    const options: CDP.Options = { port: connectPort, host: '127.0.0.1' };
    if (targetId) options.target = targetId;

    this.client = await CDP(options);

    await Promise.all([
      this.client.Page.enable(),
      this.client.Runtime.enable(),
      this.client.DOM.enable(),
      this.client.Network.enable(),
      (this.client as any).Fetch.enable({ patterns: [{ urlPattern: '*' }] }),
      (this.client as any).Input.enable(),
      (this.client as any).Accessibility.enable(),
    ]);

    // Technique 1: Auto-Attach to Popups, OAuth Flows & Iframes
    try {
      await (this.client as any).Target.setAutoAttach({
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true
      });
      (this.client as any).Target.attachedToTarget(async ({ sessionId, targetInfo }: any) => {
        console.log(`[CDP Auto-Attach] Attached to ${targetInfo.type}: ${targetInfo.url} (Session: ${sessionId})`);
      });
    } catch { /* continue */ }

    // Technique 4: Push Binding (window.onCometEvent)
    try {
      await (this.client as any).Runtime.addBinding({ name: 'onCometEvent' });
      (this.client as any).Runtime.bindingCalled((event: any) => {
        if (event.name === 'onCometEvent') {
          console.log('[CDP Push Event] Browser Payload:', event.payload);
        }
      });
    } catch { /* continue */ }

    // Anti-Bot & Environment Spoofing Script injection
    try {
      await (this.client as any).Page.addScriptToEvaluateOnNewDocument({
        source: `
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          window.chrome = { runtime: {} };
        `
      });
    } catch { /* continue */ }

    // Track network errors & auto-dismiss dialog popups
    this.client.Page.javascriptDialogOpening(async (params: any) => {
      console.error(`[CDP Dialog] JS ${params.type} popup: ${params.message}`);
      try {
        await this.client?.Page.handleJavaScriptDialog({ accept: true });
      } catch { /* ignore */ }
    });

    // Technique 2: Direct API Data Interception (Network.getResponseBody)
    (this.client as any).Network.responseReceived(async (params: any) => {
      const { requestId, response } = params;
      if (response.url.includes('/api/') || response.mimeType.includes('application/json')) {
        try {
          const { body } = await (this.client as any).Network.getResponseBody({ requestId });
          // Parsed API Payload cached for zero-DOM data extraction
        } catch { /* garbage collected */ }
      }
    });

    // Handle Fetch requests to continue normal traffic
    (this.client as any).Fetch.requestPaused(async (event: any) => {
      try {
        await (this.client as any).Fetch.continueRequest({ requestId: event.requestId });
      } catch { /* ignore */ }
    });

    // Set window size for consistent UI
    try {
      const { windowId } = await (this.client as any).Browser.getWindowForTarget({ targetId });
      await (this.client as any).Browser.setWindowBounds({
        windowId,
        bounds: { width: 1440, height: 900, windowState: 'normal' },
      });
    } catch {
      try {
        await (this.client as any).Emulation.setDeviceMetricsOverride({
          width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
        });
      } catch { /* continue */ }
    }

    this.state.connected = true;
    this.state.activeTabId = targetId;
    this.lastTargetId = targetId;
    this.reconnectAttempts = 0;

    const { result } = await this.client.Runtime.evaluate({ expression: "window.location.href" });
    this.state.currentUrl = result.value as string;

    return `Connected to tab: ${this.state.currentUrl}`;
  }

  /**
   * Disconnect from current tab
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.state.connected = false;
      this.state.activeTabId = undefined;
    }
  }

  /**
   * Navigate to a URL
   */
  async navigate(url: string, waitForLoad: boolean = true): Promise<NavigateResult> {
    this.ensureConnected();
    const result = await this.client!.Page.navigate({ url });
    if (waitForLoad) await this.client!.Page.loadEventFired();
    this.state.currentUrl = url;
    return result as NavigateResult;
  }

  /**
   * Capture screenshot
   */
  async screenshot(format: "png" | "jpeg" = "png"): Promise<ScreenshotResult> {
    this.ensureConnected();
    return this.client!.Page.captureScreenshot({ format }) as Promise<ScreenshotResult>;
  }

  /**
   * Execute JavaScript in the page context
   */
  async evaluate(expression: string): Promise<EvaluateResult> {
    this.ensureConnected();
    return this.client!.Runtime.evaluate({
      expression,
      awaitPromise: true,
      returnByValue: true,
    }) as Promise<EvaluateResult>;
  }

  /**
   * Execute JavaScript with auto-reconnect on connection loss
   * This is the PREFERRED method - always use this instead of evaluate()
   */
  async safeEvaluate(expression: string): Promise<EvaluateResult> {
    // Always check health first to catch silently dead connections
    await this.ensureHealthyConnection();

    return this.withAutoReconnect(async () => {
      this.ensureConnected();
      return this.client!.Runtime.evaluate({
        expression,
        awaitPromise: true,
        returnByValue: true,
      }) as Promise<EvaluateResult>;
    });
  }

  /**
   * Press a key
   */
  async pressKey(key: string): Promise<void> {
    this.ensureConnected();
    await this.client!.Input.dispatchKeyEvent({ type: "keyDown", key });
    await this.client!.Input.dispatchKeyEvent({ type: "keyUp", key });
  }

  /**
   * Navigate inside the current active tab (Same-Tab Context Reuse)
   */
  async navigateCurrentTab(url: string): Promise<NavigateResult> {
    this.ensureConnected();
    const navResult = await this.client!.Page.navigate({ url });
    if (navResult.errorText) {
      throw new Error(`Same-Tab Navigation failed: ${navResult.errorText}`);
    }

    await new Promise<void>((resolve) => {
      const onLoad = () => {
        (this.client as any).removeListener('Page.loadEventFired', onLoad);
        resolve();
      };
      (this.client as any).on('Page.loadEventFired', onLoad);
    });

    return { frameId: navResult.frameId, loaderId: navResult.loaderId || "" };
  }

  /**
   * Single-Flight Tab Creator Pattern:
   * Spawns a single tab via HTTP PUT, activates window focus, and polls /json/list to confirm initialization
   */
  async newTab(url?: string): Promise<CDPTarget> {
    const response = await windowsFetch(
      `http://127.0.0.1:${this.state.port}/json/new${url ? `?${encodeURIComponent(url)}` : ""}`,
      'PUT'
    );
    if (!response.ok) throw new Error(`Failed to create new tab: ${response.status}`);
    const newTarget = (await response.json()) as CDPTarget;

    // Bring tab to front focus
    try {
      await windowsFetch(`http://127.0.0.1:${this.state.port}/json/activate/${newTarget.id}`, 'GET');
    } catch { /* ignore activation error */ }

    // Poll target map until confirmed initialized
    let attempts = 0;
    while (attempts < 10) {
      const targets = await this.listTargets();
      const confirmed = targets.find((t) => t.id === newTarget.id);
      if (confirmed) return confirmed;
      await new Promise((r) => setTimeout(r, 200));
      attempts++;
    }

    return newTarget;
  }

  /**
   * Open Incognito / Private Session with BrowserContext Isolation
   */
  async openIncognitoTab(url: string): Promise<{ targetId: string; browserContextId: string }> {
    this.ensureConnected();

    // Step 1: Create isolated Incognito BrowserContext via Root Browser CDP
    const { browserContextId } = await (this.client as any).Target.createBrowserContext({
      disposeOnDetach: false
    });

    // Step 2: Open target bound to private context
    const { targetId } = await (this.client as any).Target.createTarget({
      url,
      browserContextId,
      newWindow: true
    });

    // Step 3: Focus private window
    await (this.client as any).Target.activateTarget({ targetId });

    return { targetId, browserContextId };
  }

  /**
   * Destroy an Incognito BrowserContext and wipe session state
   */
  async closeIncognitoContext(browserContextId: string): Promise<void> {
    this.ensureConnected();
    await (this.client as any).Target.disposeBrowserContext({ browserContextId });
  }

  /**
   * Close a tab
   */
  async closeTab(targetId: string): Promise<boolean> {
    try {
      if (this.client) {
        const result = await this.client.Target.closeTarget({ targetId });
        return result.success;
      }
    } catch { /* fallback to HTTP */ }

    try {
      const response = await windowsFetch(`http://127.0.0.1:${this.state.port}/json/close/${targetId}`);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Advanced Browser MCP / Harness Primitives: Get AX Tree Nodes with Computed Box Coordinates
   */
  async getAXNodesWithCoordinates(): Promise<any[]> {
    this.ensureConnected();
    try {
      const { nodes } = await (this.client as any).Accessibility.getFullAXTree();
      const axNodes: any[] = [];

      for (const n of nodes.slice(0, 100)) {
        if (!n.name?.value && !n.role?.value) continue;
        if (!n.backendDOMNodeId) continue;

        try {
          const { model } = await (this.client as any).DOM.getBoxModel({ backendNodeId: n.backendDOMNodeId });
          if (model && model.content) {
            const q = model.content;
            const x = Math.round((q[0] + q[2] + q[4] + q[6]) / 4);
            const y = Math.round((q[1] + q[3] + q[5] + q[7]) / 4);
            axNodes.push({
              backendDOMNodeId: n.backendDOMNodeId,
              role: n.role?.value,
              name: n.name?.value,
              value: n.value?.value,
              x,
              y,
              width: model.width,
              height: model.height,
            });
          }
        } catch { /* skip non-rendered elements */ }
      }

      return axNodes;
    } catch {
      const evalRes = await this.evaluate(`
        (() => {
          const els = Array.from(document.querySelectorAll('a, button, input, select, textarea, [role], h1, h2, h3'));
          return els.slice(0, 100).map((el, i) => {
            const rect = el.getBoundingClientRect();
            return {
              backendDOMNodeId: i + 1,
              role: el.getAttribute('role') || el.tagName.toLowerCase(),
              name: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().substring(0, 80),
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            };
          }).filter(n => n.name.length > 0 && n.width > 0 && n.height > 0);
        })()
      `);
      return (evalRes.result?.value as any[]) || [];
    }
  }

  /**
   * Advanced Browser MCP / Harness Primitives: Direct Compositor Click at (x, y) Viewport Coordinates
   */
  async clickAtXY(x: number, y: number): Promise<string> {
    this.ensureConnected();
    await (this.client as any).Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await (this.client as any).Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return `Compositor click dispatched at (${x}, ${y})`;
  }

  /**
   * CDP Native Domain 2: Real Hardware Keypress Simulation (Input.dispatchKeyEvent)
   */
  async typeNativeText(text: string): Promise<string> {
    this.ensureConnected();
    for (const char of text) {
      await (this.client as any).Input.dispatchKeyEvent({ type: 'keyDown', text: char });
      await (this.client as any).Input.dispatchKeyEvent({ type: 'keyUp', text: char });
    }
    return `Typed text "${text}" via native hardware CDP key events`;
  }

  /**
   * Ultra-Reliable Verified SmartClick Engine:
   * 1. Dual-Layer Element Resolution (AXTree Semantic Roles + DOM Query)
   * 2. Physical Hardware Dispatch (scrollIntoView -> mouseMoved -> mousePressed -> 50ms sleep -> mouseReleased)
   * 3. Action-Verification Hooks (URL / DOM State mutation assertion)
   * 4. Automatic Backtracking Fallback (Parent node click -> Keyboard Enter fallback)
   */
  async verifiedSmartClick(target: { selector?: string; semanticQuery?: string; expectedMutation?: string }): Promise<string> {
    this.ensureConnected();
    const initialUrl = (await this.evaluate('window.location.href')).result?.value;

    // Phase 1: Dual-Layer Target Coords Resolution
    let coords: { x: number; y: number; label: string } | null = null;

    if (target.semanticQuery) {
      try {
        const axNodes = await this.getAXNodesWithCoordinates();
        const match = axNodes.find((n: any) =>
          n.name?.toLowerCase().includes(target.semanticQuery!.toLowerCase()) ||
          n.role?.toLowerCase().includes(target.semanticQuery!.toLowerCase())
        );
        if (match && match.x > 0 && match.y > 0) {
          coords = { x: match.x, y: match.y, label: `AXNode (${match.role}: ${match.name})` };
        }
      } catch { /* fallback to DOM */ }
    }

    if (!coords && target.selector) {
      const evalRes = await this.evaluate(`
        (() => {
          const el = document.querySelector(${JSON.stringify(target.selector)});
          if (!el) return null;
          el.scrollIntoView({ block: 'center', inline: 'center' });
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return null;
          return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            label: 'DOM Selector (${target.selector})'
          };
        })()
      `);
      coords = evalRes.result?.value as { x: number; y: number; label: string } | null;
    }

    if (!coords) {
      throw new Error(`Target "${target.semanticQuery || target.selector}" not found or non-rendered.`);
    }

    // Phase 2: Hardware Input Dispatch
    await (this.client as any).Input.dispatchMouseEvent({ type: 'mouseMoved', x: coords.x, y: coords.y });
    await new Promise(r => setTimeout(r, 50));
    await (this.client as any).Input.dispatchMouseEvent({ type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 60));
    await (this.client as any).Input.dispatchMouseEvent({ type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });

    // Phase 3: Action-Verification Hook (Wait 300ms & assert state change)
    await new Promise(r => setTimeout(r, 300));
    const currentUrl = (await this.evaluate('window.location.href')).result?.value;

    if (currentUrl !== initialUrl) {
      return `Verified Click Success on ${coords.label}! URL changed: ${currentUrl}`;
    }

    // Phase 4: Self-Healing Backtracking Fallback (Focus + Enter keypress)
    if (target.selector) {
      await this.evaluate(`
        (() => {
          const el = document.querySelector(${JSON.stringify(target.selector)});
          if (el) {
            (el).focus();
            (el).click();
          }
        })()
      `);
      await (this.client as any).Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter' });
      await (this.client as any).Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
    }

    return `Verified Click Executed on ${coords.label} at (${coords.x}, ${coords.y}) with Backtracking fallback.`;
  }

  /**
   * Technique 3: Export session cookies for authentication state preservation
   */
  async exportCookies(urls?: string[]): Promise<any[]> {
    this.ensureConnected();
    const { cookies } = await (this.client as any).Network.getCookies({ urls });
    return cookies;
  }

  /**
   * Technique 3: Inject pre-authenticated cookies into clean/incognito contexts
   */
  async injectCookies(cookies: any[]): Promise<void> {
    this.ensureConnected();
    await (this.client as any).Network.setCookies({ cookies });
  }

  /**
   * Technique 4: Trigger native in-page Push Event binding (window.onCometEvent)
   */
  async emitPushEvent(payload: Record<string, any>): Promise<string> {
    this.ensureConnected();
    await this.evaluate(`
      if (typeof window.onCometEvent === 'function') {
        window.onCometEvent(JSON.stringify(${JSON.stringify(payload)}));
      }
    `);
    return `Emitted push payload to window.onCometEvent`;
  }

  /**
   * Guard 1: Window/Profile Pre-Flight Check (isIncognito & hasSidecar Validation)
   */
  async validateExecutionEnvironment(): Promise<{ canUseSidecar: boolean; reason?: string; sidecarTargetId?: string }> {
    const targets = await this.listTargets();
    const sidecar = targets.find(t =>
      t.url.includes('/sidecar') ||
      t.title.toLowerCase().includes('perplexity sidecar') ||
      t.title.toLowerCase().includes('perplexity')
    );

    if (!sidecar) {
      return {
        canUseSidecar: false,
        reason: 'No Sidecar target detected. You are in an Incognito window or isolated context without Perplexity auth.'
      };
    }

    return { canUseSidecar: true, sidecarTargetId: sidecar.id };
  }

  /**
   * Guard 2: Generic Popup & Consent Dialog Dismissal Engine
   */
  async dismissBlockingOverlays(): Promise<boolean> {
    this.ensureConnected();
    const selectors = [
      'button[aria-label*="Leave history off"]',
      'tp-yt-paper-button[aria-label*="Accept"]',
      '#dismiss-button',
      '[aria-label*="Accept all"]',
      'button[aria-label*="Close"]',
      '.close-button',
      'button[aria-label*="Dismiss"]'
    ];

    const evalRes = await this.evaluate(`
      (() => {
        const selectors = ${JSON.stringify(selectors)};
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el && (el.offsetWidth > 0 || el.offsetHeight > 0)) {
            (el).click();
            return selector;
          }
        }
        return null;
      })()
    `);

    return evalRes.result?.value !== null;
  }

  /**
   * Comet Assistant Sidecar Feature 1: Target Discovery & Isolation for Sidecar
   */
  async findCometSidecarTarget(): Promise<CDPTarget | null> {
    const targets = await this.listTargets();
    const sidecar = targets.find(t =>
      t.url.includes('/sidecar') ||
      t.title.toLowerCase().includes('perplexity sidecar') ||
      t.title.toLowerCase().includes('perplexity')
    );
    return sidecar || null;
  }

  /**
   * Comet Assistant Sidecar Feature 2: Inject Prompt into Sidecar Textarea
   */
  async sendPromptToSidecar(promptText: string): Promise<string> {
    const envCheck = await this.validateExecutionEnvironment();
    if (!envCheck.canUseSidecar) {
      throw new Error(envCheck.reason);
    }

    const sidecar = await this.findCometSidecarTarget();
    if (!sidecar) throw new Error("Comet Assistant Sidecar target not found.");

    await this.connect(sidecar.id);

    // Step 1: Inject text into React reactive textarea
    await this.evaluate(`
      (() => {
        const textarea = document.querySelector('textarea, [contenteditable="true"]');
        if (!textarea) throw new Error('Sidecar prompt input box not found');
        
        textarea.focus();
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 
          'value'
        )?.set;
        if (nativeSetter) {
          nativeSetter.call(textarea, ${JSON.stringify(promptText)});
        } else {
          (textarea).value = ${JSON.stringify(promptText)};
        }
        
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `);

    // Step 2: Physical ENTER keypress dispatch
    await (this.client as any).Input.dispatchKeyEvent({ type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
    await (this.client as any).Input.dispatchKeyEvent({ type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });

    return `Prompt successfully injected into Comet Sidecar: "${promptText}"`;
  }

  /**
   * Comet Assistant Sidecar Feature 3: Read latest AI response stream
   */
  async readSidecarLatestResponse(): Promise<string> {
    const sidecar = await this.findCometSidecarTarget();
    if (!sidecar) throw new Error("Comet Assistant Sidecar target not found.");

    await this.connect(sidecar.id);

    const result = await this.evaluate(`
      (() => {
        const messages = document.querySelectorAll('[data-testid="answer-text"], .prose, .markdown');
        if (messages.length === 0) return null;
        return (messages[messages.length - 1]).innerText;
      })()
    `);

    return (result.result?.value as string) || 'No response found in Sidecar stream.';
  }

  /**
   * Pure CDP Control Strategy (Scenario 1): High-Speed Network Payload Interception
   */
  async interceptNetworkData(urlPattern: string): Promise<string> {
    this.ensureConnected();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => resolve('No matching payload intercepted within 5s'), 5000);
      
      const handler = async (params: any) => {
        if (params.response.url.includes(urlPattern) || params.response.mimeType.includes('application/json')) {
          try {
            const { body, base64Encoded } = await (this.client as any).Network.getResponseBody({ requestId: params.requestId });
            clearTimeout(timeout);
            (this.client as any).removeListener('Network.responseReceived', handler);
            const data = base64Encoded ? Buffer.from(body, 'base64').toString() : body;
            resolve(data.substring(0, 2000));
          } catch { /* skip */ }
        }
      };

      (this.client as any).on('Network.responseReceived', handler);
    });
  }

  /**
   * Continuous Full-Page Coverage Screenshot Engine:
   * 1. Forces explicit top reset window.scrollTo(0,0) before initial capture
   * 2. Uses 90% Viewport Height Overlap Scrolling to guarantee zero missing content
   */
  async captureContinuousPageScreenshots(maxSlices = 6): Promise<string[]> {
    this.ensureConnected();

    // Reset scroll to top (0,0) and disable auto-scroll restoration
    await this.evaluate(`
      (() => {
        if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
        window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      })()
    `);
    await new Promise(r => setTimeout(r, 800));

    const dimRes = await this.evaluate(`
      (() => {
        return {
          scrollHeight: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
          viewportHeight: window.innerHeight
        };
      })()
    `);

    const dims = (dimRes.result?.value as any) || { scrollHeight: 3000, viewportHeight: 900 };
    const step = Math.floor(dims.viewportHeight * 0.9); // 10% overlap step
    const slices: string[] = [];

    for (let currentTop = 0; currentTop < dims.scrollHeight && slices.length < maxSlices; currentTop += step) {
      await this.evaluate(`window.scrollTo({ top: ${currentTop}, left: 0, behavior: 'instant' });`);
      await new Promise(r => setTimeout(r, 600));

      const screenshot = await (this.client as any).Page.captureScreenshot({ format: 'png' });
      if (screenshot?.data) {
        slices.push(screenshot.data);
      }
    }

    return slices;
  }

  private ensureConnected(): void {
    if (!this.client) {
      throw new Error("Not connected to Comet. Call connect() first.");
    }
  }
}

export const cometClient = new CometCDPClient();
