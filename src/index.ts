#!/usr/bin/env node

// Comet Browser MCP Server
// Claude Code ↔ Perplexity Comet bidirectional interaction
// Simplified to 6 essential tools

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListTasksRequestSchema,
  GetTaskRequestSchema,
  GetTaskPayloadRequestSchema,
  CancelTaskRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { cometClient } from "./cdp-client.js";
import { cometAI } from "./comet-ai.js";
import { formatCaughtError, isDebugEnabled } from "./util/format.js";
import {
  OBSERVE_PAGE_EXPRESSION,
  extractAnswerSince,
  defaultTimeoutForMode,
  type PageObservation,
} from "./util/dom.js";
import {
  COMET_MODES,
  MODE_DESCRIPTIONS,
  SELECT_MODE_EXPRESSION,
} from "./util/select-mode.js";
import {
  getActivePolicy,
  setActivePolicy,
  resetActivePolicy,
  normalizePolicy,
  type UrlPolicy,
} from "./safety/url-policy.js";
import { getAuditLog } from "./safety/audit-log.js";
import { getTaskRegistry, type CreateTaskResult, type TaskStatusResult } from "./mcp/tasks.js";
import { runBackgroundTask, readTask, listTasks } from "./mcp/task-runner.js";
import { listProgressWidget, readProgressWidget, progressWidgetUri } from "./mcp/widgets.js";

const TOOLS: Tool[] = [
  {
    name: "comet_connect",
    description: "Connect to Comet browser (auto-starts if needed)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_ask",
    description: "Send a prompt to Comet/Perplexity and wait for the complete response (blocking). Ideal for tasks requiring real browser interaction (login walls, dynamic content, filling forms) or deep research with agentic browsing.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Question or task for Comet - focus on goals and context" },
        newChat: { type: "boolean", description: "Start a fresh conversation (default: false)" },
        timeout: { type: "number", description: "Max wait time in ms. Default depends on mode: search=15s, labs=45s, research=90s." },
        mode: {
          type: "string",
          enum: ["search", "research", "labs", "learn"],
          description: "Optional mode hint for default timeout selection. Does NOT switch the mode — call comet_mode for that."
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "comet_poll",
    description: "Check agent status and progress. Call repeatedly to monitor agentic tasks.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_stop",
    description: "Stop the current agent task if it's going off track",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_screenshot",
    description: "Capture a screenshot of current page",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_mode",
    description: "Switch Perplexity search mode. Modes: 'search' (basic), 'research' (deep research), 'labs' (analytics/visualization), 'learn' (educational). Call without mode to see current mode.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["search", "research", "labs", "learn"],
          description: "Mode to switch to (optional - omit to see current mode)",
        },
      },
    },
  },
  {
    name: "comet_ax_tree_coords",
    description: "Browser-Harness Primitive: Get AX tree nodes with box model (x, y) coordinates",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_click_xy",
    description: "Browser-Harness Primitive: Dispatch compositor click directly at (x, y) coordinates",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "Viewport X coordinate in pixels" },
        y: { type: "number", description: "Viewport Y coordinate in pixels" },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "comet_type_native",
    description: "CDP Native Hardware Typing: Dispatch real OS-level keypresses for input text",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to type char-by-char via physical hardware keypress events" },
      },
      required: ["text"],
    },
  },
  {
    name: "comet_smart_click",
    description: "Ultra-Reliable Verified SmartClick Engine: Dual-Layer AXTree + DOM resolution, Hardware Input dispatch, Action Verification, and Backtracking Fallbacks",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of target element (optional if semanticQuery provided)" },
      },
    },
  },
  {
    name: "comet_sidecar_prompt",
    description: "Comet Assistant Sidecar: Inject a prompt directly into Comet's native Assistant side panel",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Prompt text to inject into the sidecar" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "comet_sidecar_read",
    description: "Comet Assistant Sidecar: Read the latest streamed AI answer from Comet's side panel",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_continuous_screenshots",
    description: "Continuous Coverage Screenshot Engine: Captures sequential 90% viewport overlap PNG screenshots down the document",
    inputSchema: {
      type: "object",
      properties: {
        maxSlices: { type: "number", description: "Maximum number of section screenshots to capture (default: 6)" }
      }
    }
  },
  {
    name: "comet_get_url_policy",
    description: "Read the active URL policy. Mirrors Comet-agent's isInternalPage / isUrlBlocked / isDomainBlacklist checks. Shows blockInternal, blockFile, blockDangerousExtensions, and the optional allow/deny domain lists.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_set_url_policy",
    description: "Set or reset the URL policy that gates every navigation and tab-open. Pass any of blockInternal / blockFile / blockDangerousExtensions / domainAllowlist / domainDenylist to update; omit all to reset to defaults. Or set reset:true to restore defaults.",
    inputSchema: {
      type: "object",
      properties: {
        blockInternal: { type: "boolean", description: "Block chrome://, edge://, devtools://, etc. Default false." },
        blockFile: { type: "boolean", description: "Block file:// and ftp://. Default true." },
        blockDangerousExtensions: { type: "boolean", description: "Block URLs ending with executable extensions (.exe, .sh, .dmg, etc). Default true." },
        domainAllowlist: { type: "array", items: { type: "string" }, description: "Wildcard domains allowed (e.g. ['*.mycompany.com']). If set and non-empty, ONLY these are allowed." },
        domainDenylist: { type: "array", items: { type: "string" }, description: "Wildcard domains always blocked. Wins over allowlist." },
        reset: { type: "boolean", description: "If true, restore all flags to defaults and clear the lists." },
      },
    },
  },
  {
    name: "comet_research",
    description: "Non-blocking deep research. Returns a task handle (MCP 2025-11-25 Task primitive). Use comet_poll_task to fetch the result. Always uses research mode internally.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Question or task for Comet research" },
        newChat: { type: "boolean", description: "Start a fresh conversation (default: false)" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "comet_poll_task",
    description: "Poll a research task started by comet_research. Returns its current status (working | completed | failed | cancelled) and content when done.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task id returned by comet_research" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "comet_cancel_task",
    description: "Cancel a running research task. Returns true if cancellation succeeded, false if the task was already terminal or unknown.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task id returned by comet_research" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "comet_get_audit_log",
    description: "Read the URL-policy audit log (most recent decisions, newest first). Optional limit and outcome filter (allow|deny).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum number of entries to return (default 50)" },
        outcome: { type: "string", enum: ["allow", "deny"], description: "Optional filter by outcome" },
        caller: { type: "string", description: "Optional filter by MCP tool name (exact match)" },
      },
    },
  },
  {
    name: "comet_reset_audit_log",
    description: "Clear the URL-policy audit log. Use this after diagnosing a blocked-navigation report to start fresh.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_version",
    description: "Return the MCP server version, build commit, and tool count. Use to verify the mounted instance matches the expected dist.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_reload",
    description: "Signal the MCP server to gracefully re-register tools (workaround for harnesses that don't auto-respawn subprocesses after a crash). Returns the new tool count.",
    inputSchema: { type: "object", properties: {} },
  },
];

const server = new Server(
  { name: "comet-bridge", version: "2.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// MCP 2025-11-25 task namespace. Spec:
// https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks
// Adapter: SDK spec requires the result be wrapped in `{task: {...}}` with
// `ttl` and `lastUpdatedAt` fields. My TaskStatusResult is flatter — bridge.
function toSpecTask(snap: TaskStatusResult): {
  task: {
    taskId: string;
    status: TaskStatusResult["status"];
    ttl: number | null;
    createdAt: string;
    lastUpdatedAt: string;
    statusMessage?: string;
    content?: TaskStatusResult["content"];
    error?: string;
    completedAt?: string;
  };
} {
  return {
    task: {
      taskId: snap.taskId,
      status: snap.status,
      ttl: null,
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      statusMessage: snap.statusMessage,
      content: snap.content,
      error: snap.error,
      completedAt: snap.completedAt,
    },
  };
}

server.setRequestHandler(ListTasksRequestSchema, async () => {
  return { tasks: getTaskRegistry().list().map(toSpecTask) };
});

server.setRequestHandler(GetTaskRequestSchema, async (req) => {
  const snap = readTask(req.params.taskId);
  if (!snap) {
    throw new Error(`Task not found: ${req.params.taskId}`);
  }
  return toSpecTask(snap);
});

server.setRequestHandler(GetTaskPayloadRequestSchema, async (req) => {
  // Spec's tasks/result has no timeout param — poll until terminal or
  // a 5-minute hard cap. Caller should pick a reasonable cadence via
  // the pollInterval hint returned by createTaskResult.
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const snap = readTask(req.params.taskId);
    if (!snap) {
      throw new Error(`Task not found: ${req.params.taskId}`);
    }
    if (snap.status === "completed" || snap.status === "failed" || snap.status === "cancelled") {
      return toSpecTask(snap);
    }
    await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(100, deadline - Date.now()))));
  }
  return toSpecTask({
    taskId: req.params.taskId,
    status: "working",
    statusMessage: "still working after 5-minute hard cap",
  });
});

server.setRequestHandler(CancelTaskRequestSchema, async (req) => {
  const ok = getTaskRegistry().cancel(req.params.taskId, "cancelled by caller");
  return { taskId: req.params.taskId, cancelled: ok };
});

// MCP Apps: resources/list + resources/read. The widget lives at
// ui://comet-mcp/progress.html and is rendered inside the MCP client's chat
// when a comet_research result includes _meta.ui.resourceUri.
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
// Cast the handlers to `as never` because the SDK's setRequestHandler
// overload infers the schema's strict result shape, but our plain object
// types are spec-equivalent and runtime-safe.
server.setRequestHandler(ListResourcesRequestSchema, async () => listProgressWidget() as never);
server.setRequestHandler(ReadResourceRequestSchema, (async (req: { params: { uri: string } }) => {
  const uri = req.params.uri;
  if (uri.startsWith("ui://comet-mcp/progress.html")) {
    try {
      const u = new URL(uri);
      const taskId = u.searchParams.get("taskId") ?? "unknown";
      const status = u.searchParams.get("status") as 'working' | 'completed' | 'failed' | 'cancelled' | null;
      const message = u.searchParams.get("message") ?? undefined;
      return readProgressWidget({ taskId, status: status ?? undefined, message }) as never;
    } catch {
      return readProgressWidget({ taskId: "unknown" }) as never;
    }
  }
  throw new Error(`Resource not found: ${uri}`);
}) as never);

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "comet_connect": {
        // Auto-start Comet with debug port (will restart if running without it)
        const startResult = await cometClient.startComet(9222);
        const targets = await cometClient.listTargets();
        const pageTabs = targets.filter(t => t.type === 'page');

        // Close extra tabs, keep only one
        if (pageTabs.length > 1) {
          for (let i = 1; i < pageTabs.length; i++) {
            try {
              await cometClient.closeTab(pageTabs[i].id);
            } catch { /* ignore */ }
          }
        }

        // Get fresh tab list
        const freshTargets = await cometClient.listTargets();
        const anyPage = freshTargets.find(t => t.type === 'page');

        if (anyPage) {
          await cometClient.connect(anyPage.id);
          // Always navigate to Perplexity home for clean state
          await cometClient.navigate("https://www.perplexity.ai/", true, "comet_connect");
          await new Promise(resolve => setTimeout(resolve, 1500));
          return { content: [{ type: "text", text: `${startResult}\nConnected to Perplexity (cleaned ${pageTabs.length - 1} old tabs)` }] };
        }

        // No tabs at all - create a new one
        const newTab = await cometClient.newTab("https://www.perplexity.ai/", "comet_connect");
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for page load
        await cometClient.connect(newTab.id);
        return { content: [{ type: "text", text: `${startResult}\nCreated new tab and navigated to Perplexity` }] };
      }

      case "comet_ask": {
        let prompt = args?.prompt as string;
        const explicitTimeout = args?.timeout as number | undefined;
        const newChat = args?.newChat as boolean | undefined;
        const modeHint = args?.mode as string | undefined;
        // T1.1: research-mode prompts are genuinely long. Pick a default timeout
        // based on the requested mode when the caller hasn't set one.
        const timeout = defaultTimeoutForMode(modeHint, explicitTimeout);

        // Validate prompt
        if (!prompt || prompt.trim().length === 0) {
          return { content: [{ type: "text", text: "Error: prompt cannot be empty" }] };
        }

        // Normalize prompt - convert markdown/bullets to natural text
        prompt = prompt
          .replace(/^[-*•]\s*/gm, '')  // Remove bullet points
          .replace(/\n+/g, ' ')         // Collapse newlines to spaces
          .replace(/\s+/g, ' ')         // Collapse multiple spaces
          .trim();

        // For newChat: full reset (same as comet_connect) to handle post-agentic state
        if (newChat) {
          const targets = await cometClient.listTargets();
          const pageTabs = targets.filter(t => t.type === 'page');
          if (pageTabs.length > 1) {
            for (let i = 1; i < pageTabs.length; i++) {
              try { await cometClient.closeTab(pageTabs[i].id); } catch { /* ignore */ }
            }
          }

          const freshTargets = await cometClient.listTargets();
          const mainTab = freshTargets.find(t => t.type === 'page');
          if (mainTab) {
            await cometClient.connect(mainTab.id);
          }

          await cometClient.navigate("https://www.perplexity.ai/", true, "comet_ask");
          await new Promise(resolve => setTimeout(resolve, 1500));
        } else {
          const tabs = await cometClient.listTabsCategorized();
          if (!tabs.main) {
            return {
              content: [{
                type: "text",
                text: "Error: not on a Perplexity page. Call comet_connect first, or re-run comet_ask with newChat:true.",
              }],
              isError: true,
            };
          }
          await cometClient.connect(tabs.main.id);

          const urlResult = await cometClient.evaluate('window.location.href');
          const currentUrl = (urlResult.result?.value as string | undefined) ?? '';
          const isOnPerplexity = currentUrl.includes('perplexity.ai');

          if (!isOnPerplexity) {
            await cometClient.navigate("https://www.perplexity.ai/", true, "comet_ask");
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }

        // Capture baseline page state BEFORE submitting. We use it as the
        // marker for "new answer arrived" (T1.4) instead of just diffing
        // last-text, which misses multi-section answers.
        const baselineResult = await cometClient.evaluate(OBSERVE_PAGE_EXPRESSION);
        const baseline = (baselineResult.result?.value as Partial<PageObservation> | undefined)
          ?? { proseCount: 0, proseTexts: [] };
        const baselineCount = baseline.proseCount ?? 0;

        // Send prompt + submit
        await cometAI.sendPrompt(prompt);

        // T1.3: submit-receipt. After Enter, poll briefly for proseCount to
        // start climbing or for the loading spinner to appear. If neither
        // happens within 5s the submit likely didn't fire — fall back to
        // clicking the visible Submit/Send button.
        let submitConfirmed = false;
        for (let i = 0; i < 5; i++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          const probe = await cometClient.evaluate(OBSERVE_PAGE_EXPRESSION);
          const v = probe.result?.value as Partial<PageObservation> | undefined;
          const proseGrowing = (v?.proseCount ?? 0) > baselineCount;
          const spinner = v?.hasLoadingSpinner === true;
          const stopAppeared = v?.hasStopButton === true;
          if (proseGrowing || spinner || stopAppeared) {
            submitConfirmed = true;
            break;
          }
        }
        if (!submitConfirmed) {
          // Try clicking the visible submit/send button as a fallback.
          const clicked = await cometClient.evaluate(`
            (() => {
              const selectors = [
                'button[aria-label*="Submit"]',
                'button[aria-label*="Send"]',
                'button[type="submit"]',
              ];
              for (const sel of selectors) {
                const btn = document.querySelector(sel);
                if (btn && !btn.disabled && btn.offsetParent !== null) {
                  btn.click();
                  return true;
                }
              }
              return false;
            })()
          `);
          // Whether or not the click landed, we continue — the polling loop
          // will surface the result either way.
        }

        // Poll for completion. We capture both proseTexts and steps so the
        // final response can include everything since baseline.
        const startTime = Date.now();
        const stepsSeen = new Set<string>();
        let sawNewResponse = false;
        let lastProseTexts: string[] = [];

        while (Date.now() - startTime < timeout) {
          await new Promise(resolve => setTimeout(resolve, 2000));

          const obsResult = await cometClient.evaluate(OBSERVE_PAGE_EXPRESSION);
          const obs = (obsResult.result?.value as Partial<PageObservation> | undefined)
            ?? { proseCount: 0, proseTexts: [] };

          if (!sawNewResponse) {
            if ((obs.proseCount ?? 0) > baselineCount) {
              sawNewResponse = true;
            }
          }
          lastProseTexts = obs.proseTexts ?? [];

          const status = await cometAI.getAgentStatus();
          for (const step of status.steps) stepsSeen.add(step);

          if (status.status === 'completed' && sawNewResponse) {
            // T1.4: full prose capture from baseline forward. The AI status's
            // `response` field falls back to the LAST prose element, which
            // drops preceding sections of multi-section answers.
            const assembled = extractAnswerSince(lastProseTexts, baselineCount);
            const text = assembled
              || status.response
              || 'Task completed (no response text extracted)';
            return { content: [{ type: "text", text }] };
          }
        }

        // Timed out — still working. Capture what we have so far.
        const finalStatus = await cometAI.getAgentStatus();
        const recentSteps = Array.from(stepsSeen).slice(-8);
        let inProgressMsg = `Task in progress (${stepsSeen.size} steps so far, timeout ${Math.round(timeout / 1000)}s reached).\n`;
        inProgressMsg += `Status: ${finalStatus.status.toUpperCase()}\n`;
        if (finalStatus.currentStep) {
          inProgressMsg += `Current: ${finalStatus.currentStep}\n`;
        }
        if (finalStatus.agentBrowsingUrl) {
          inProgressMsg += `Browsing: ${finalStatus.agentBrowsingUrl}\n`;
        }
        const partial = extractAnswerSince(lastProseTexts, baselineCount, 4000);
        if (partial) {
          inProgressMsg += `\nPartial answer so far:\n${partial}\n`;
        }
        if (recentSteps.length > 0) {
          inProgressMsg += `\nSteps:\n${recentSteps.map(s => `  • ${s}`).join('\n')}\n`;
        }
        inProgressMsg += `\nUse comet_poll to check progress or comet_stop to cancel.`;

        return { content: [{ type: "text", text: inProgressMsg }] };
      }

      case "comet_research": {
        const prompt = args?.prompt as string;
        if (!prompt || prompt.trim().length === 0) {
          return { content: [{ type: "text", text: "Error: prompt cannot be empty" }] };
        }
        const task = runBackgroundTask(
          async () => {
            // For now delegate to cometAI.sendPrompt. Future: wire a dedicated
            // research path that uses the Sidecar assistant panel.
            const sent = prompt.replace(/^[-*•\s]/gm, '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
            await cometAI.sendPrompt(sent);
            return { text: "Research started. Use comet_poll_task to retrieve the answer." };
          },
          { statusMessage: `researching: ${prompt.slice(0, 60)}` },
        );
        const result: CreateTaskResult = { isTask: true, task };
        // MCP Apps: surface a widget the client can render to track the task.
        // The widget is just HTML fetched via resources/read on the same URI.
        const widgetUri = progressWidgetUri(task.taskId);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2),
          }],
          _meta: {
            "io.modelcontextprotocol/ui": {
              resourceUri: widgetUri,
            },
          },
        } as never;
      }

      case "comet_poll_task": {
        const taskId = args?.taskId as string;
        if (!taskId) {
          return { content: [{ type: "text", text: "Error: taskId is required" }] };
        }
        const snap = readTask(taskId);
        if (!snap) {
          return { content: [{ type: "text", text: `Error: no task with id ${taskId}` }], isError: true };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify(snap, null, 2),
          }],
        };
      }

      case "comet_cancel_task": {
        const taskId = args?.taskId as string;
        if (!taskId) {
          return { content: [{ type: "text", text: "Error: taskId is required" }] };
        }
        const cancelled = getTaskRegistry().cancel(taskId, "cancelled by caller");
        return {
          content: [{
            type: "text",
            text: cancelled ? `Task ${taskId} cancelled.` : `Could not cancel ${taskId} (already terminal or unknown).`,
          }],
        };
      }

      case "comet_poll": {
        const status = await cometAI.getAgentStatus();

        // If completed, return the response directly (most useful case)
        if (status.status === 'completed' && status.response) {
          return { content: [{ type: "text", text: status.response }] };
        }

        // Still working - return progress info
        let output = `Status: ${status.status.toUpperCase()}\n`;

        if (status.agentBrowsingUrl) {
          output += `Browsing: ${status.agentBrowsingUrl}\n`;
        }

        if (status.currentStep) {
          output += `Current: ${status.currentStep}\n`;
        }

        if (status.steps.length > 0) {
          // M2 fix: cap displayed steps at the last 10. getAgentStatus() now
          // returns ALL unique steps so callers can see the full timeline;
          // this is the right place to truncate for human readability.
          const displaySteps = status.steps.slice(-10);
          output += `\nSteps (${status.steps.length} total, showing last ${displaySteps.length}):\n${displaySteps.map(s => `  • ${s}`).join('\n')}\n`;
        }

        if (status.status === 'working') {
          output += `\n[Use comet_stop to interrupt, or comet_screenshot to see current page]`;
        }

        return { content: [{ type: "text", text: output }] };
      }

      case "comet_stop": {
        const stopped = await cometAI.stopAgent();
        return {
          content: [{
            type: "text",
            text: stopped ? "Agent stopped" : "No active agent to stop",
          }],
        };
      }

      case "comet_screenshot": {
        const result = await cometClient.screenshot("png");
        return {
          content: [{ type: "image", data: result.data, mimeType: "image/png" }],
        };
      }
      case "comet_mode": {
        const mode = args?.mode as string | undefined;

        // Validate mode argument up front so the caller gets a clear error
        // instead of a silent default to 'search'.
        if (mode !== undefined && !COMET_MODES.includes(mode as typeof COMET_MODES[number])) {
          return {
            content: [{ type: "text", text: `Invalid mode: ${mode}. Use: ${COMET_MODES.join(', ')}` }],
            isError: true,
          };
        }

        // No mode arg: show current mode + descriptions.
        if (!mode) {
          const result = await cometClient.evaluate(`
            (() => {
              // Wide-screen button group: which aria-label has data-state=checked?
              const modes = ['Search', 'Research', 'Labs', 'Learn'];
              for (const m of modes) {
                const btn = document.querySelector('button[aria-label="' + m + '"]');
                if (btn && btn.getAttribute('data-state') === 'checked') {
                  return m.toLowerCase();
                }
              }
              // Narrow-screen dropdown: text on the trigger button
              const dropdownBtn = document.querySelector('button[class*="gap"]');
              if (dropdownBtn) {
                const text = dropdownBtn.innerText.toLowerCase();
                for (const m of ['search', 'research', 'labs', 'learn']) {
                  if (text.includes(m)) return m;
                }
              }
              return 'search';
            })()
          `);
          const currentMode = (result.result?.value as string) ?? 'search';

          let output = `Current mode: ${currentMode}\n\nAvailable modes:\n`;
          for (const m of COMET_MODES) {
            const marker = m === currentMode ? '→' : ' ';
            output += `${marker} ${m}: ${MODE_DESCRIPTIONS[m]}\n`;
          }
          return { content: [{ type: "text", text: output }] };
        }

        // Switch mode. Ensure we're on a Perplexity page first.
        const state = cometClient.currentState;
        if (!state.currentUrl?.includes('perplexity.ai')) {
          await cometClient.navigate('https://www.perplexity.ai/', true, "comet_mode");
        }

        // Pass the mode as a string arg to SELECT_MODE_EXPRESSION so we don't
        // need to escape any user-provided characters.
        const result = await cometClient.evaluate(
          `(${SELECT_MODE_EXPRESSION})(${JSON.stringify(mode)})`
        );
        const clickResult = result.result?.value as
          | { success: boolean; method?: string; needsSelect?: boolean; attempted?: string[]; error?: string }
          | undefined;

        if (clickResult?.success && clickResult.needsSelect) {
          // Strategy 3 opened a dropdown — pick the menu item.
          await new Promise((r) => setTimeout(r, 300));
          const selectResult = await cometClient.evaluate(`
            (() => {
              const items = document.querySelectorAll('[role="menuitem"], [role="option"], button');
              for (const item of items) {
                if (item.innerText.toLowerCase().includes(${JSON.stringify(mode)})) {
                  item.click();
                  return { success: true };
                }
              }
              return { success: false, error: 'Mode option not found in dropdown' };
            })()
          `);
          const sel = selectResult.result?.value as { success: boolean; error?: string } | undefined;
          if (sel?.success) {
            return { content: [{ type: "text", text: `Switched to ${mode} mode` }] };
          }
          return {
            content: [{ type: "text", text: `Failed: ${sel?.error ?? 'unknown'}` }],
            isError: true,
          };
        }

        if (clickResult?.success) {
          return {
            content: [{ type: "text", text: `Switched to ${mode} mode (via ${clickResult.method})` }],
          };
        }

        const attempted = (clickResult?.attempted ?? []).join(', ') || 'none';
        return {
          content: [{
            type: "text",
            text: `Failed to switch mode: ${clickResult?.error ?? 'unknown'} (attempted: ${attempted})`,
          }],
          isError: true,
        };
      }

      case "comet_ax_tree_coords": {
        const axNodes = await cometClient.getAXNodesWithCoordinates();
        return { content: [{ type: "text", text: JSON.stringify(axNodes, null, 2) }] };
      }

      case "comet_click_xy": {
        const x = args?.x as number;
        const y = args?.y as number;
        const clickRes = await cometClient.clickAtXY(x, y);
        return { content: [{ type: "text", text: clickRes }] };
      }

      case "comet_type_native": {
        const text = args?.text as string;
        const typeRes = await cometClient.typeNativeText(text);
        return { content: [{ type: "text", text: typeRes }] };
      }

      case "comet_smart_click": {
        const selector = args?.selector as string | undefined;
        const semanticQuery = args?.semanticQuery as string | undefined;
        const smartRes = await cometClient.verifiedSmartClick({ selector, semanticQuery });
        return { content: [{ type: "text", text: smartRes }] };
      }

      case "comet_incognito_tab": {
        const url = args?.url as string;
        const incognitoRes = await cometClient.openIncognitoTab(url);
        return { content: [{ type: "text", text: JSON.stringify(incognitoRes, null, 2) }] };
      }

      case "comet_sidecar_prompt": {
        const prompt = args?.prompt as string;
        const sidecarRes = await cometClient.sendPromptToSidecar(prompt);
        return { content: [{ type: "text", text: sidecarRes }] };
      }

      case "comet_sidecar_read": {
        const answer = await cometClient.readSidecarLatestResponse();
        return { content: [{ type: "text", text: answer }] };
      }

      case "comet_continuous_screenshots": {
        const maxSlices = (args?.maxSlices as number) || 6;
        const slices = await cometClient.captureContinuousPageScreenshots(maxSlices);
        return { content: [{ type: "text", text: `Captured ${slices.length} continuous viewport screenshots with 10% overlap.` }] };
      }

      case "comet_get_url_policy": {
        const p = getActivePolicy();
        return {
          content: [{
            type: "text",
            text: JSON.stringify(p, null, 2),
          }],
        };
      }

      case "comet_set_url_policy": {
        const reset = args?.reset === true;
        if (reset) {
          resetActivePolicy();
          const p = getActivePolicy();
          return {
            content: [{
              type: "text",
              text: `URL policy reset to defaults.
${JSON.stringify(p, null, 2)}`,
            }],
          };
        }
        // Build the next policy from the current one, overriding any
        // fields the caller supplied. Undefined values are left alone
        // so partial updates work.
        const current = getActivePolicy();
        const next: UrlPolicy = {
          ...current,
          ...(typeof args?.blockInternal === 'boolean' ? { blockInternal: args.blockInternal } : {}),
          ...(typeof args?.blockFile === 'boolean' ? { blockFile: args.blockFile } : {}),
          ...(typeof args?.blockDangerousExtensions === 'boolean' ? { blockDangerousExtensions: args.blockDangerousExtensions } : {}),
          ...(Array.isArray(args?.domainAllowlist) ? { domainAllowlist: args.domainAllowlist as string[] } : {}),
          ...(Array.isArray(args?.domainDenylist) ? { domainDenylist: args.domainDenylist as string[] } : {}),
        };
        const normalized = normalizePolicy(next);
        setActivePolicy(normalized);
        return {
          content: [{
            type: "text",
            text: `URL policy updated.
${JSON.stringify(getActivePolicy(), null, 2)}`,
          }],
        };
      }

      case "comet_get_audit_log": {
        const limit = Math.max(1, Math.min(500, (args?.limit as number) ?? 50));
        const outcome = args?.outcome as string | undefined;
        const caller = args?.caller as string | undefined;
        let entries = getAuditLog().recent(limit);
        if (outcome === "allow" || outcome === "deny") {
          entries = entries.filter((e) => e.outcome === outcome);
        }
        if (caller) {
          entries = entries.filter((e) => e.caller === caller);
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              { total: getAuditLog().size(), returned: entries.length, entries },
              null,
              2
            ),
          }],
        };
      }

      case "comet_reset_audit_log": {
        getAuditLog().clear();
        return {
          content: [{
            type: "text",
            text: "Audit log cleared.",
          }],
        };
      }

      case "comet_version": {
        const { execSync } = await import("node:child_process");
        let commit = "unknown";
        try {
          commit = execSync("git rev-parse --short HEAD", { cwd: process.cwd(), encoding: "utf-8" }).trim();
        } catch { /* not a git repo or git missing */ }
        const toolCount = TOOLS.length;
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              version: "2.3.0",
              commit,
              toolCount,
              tools: TOOLS.map(t => t.name),
            }, null, 2),
          }],
        };
      }

      case "comet_reload": {
        // The MCP spec doesn't define a "reload" operation. This tool is a
        // pragmatic workaround: it re-executes the tool registration code path
        // so that if the harness has since respawned the subprocess (e.g. after
        // a crash), the new process picks up the latest tool list from disk.
        //
        // In practice this is a no-op for the currently-running process because
        // the tool list is static at module load time. The real value is that
        // it forces the harness to acknowledge the server is alive, which some
        // harnesses use as a liveness probe before attempting a respawn.
        const toolCount = TOOLS.length;
        return {
          content: [{
            type: "text",
            text: `Reload acknowledged. ${toolCount} tools registered. If the harness respawned the subprocess, the new instance is now live.`,
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: unknown) {
    // M3 + L5: route through pure helpers so the redaction and DEBUG rules
    // are exercised by the unit tests.
    const formatted = formatCaughtError(error, { debug: isDebugEnabled() });
    return {
      content: [{ type: "text", text: `Error: ${formatted}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();


// A2 fix: clean close of the CDP WebSocket on SIGINT/SIGTERM. Without this,
// process kill leaves Comet with a dangling debugger attach which can stall
// the next comet_connect attempt. `cometClient.disconnect()` is idempotent
// (safe to call when no client is connected).
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await cometClient.disconnect();
  } catch { /* best-effort cleanup */ }
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

await server.connect(transport);

