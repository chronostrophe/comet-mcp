#!/usr/bin/env node

// Comet Browser MCP Server
// Claude Code ↔ Perplexity Comet bidirectional interaction
// Simplified to 6 essential tools

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { cometClient } from "./cdp-client.js";
import { cometAI } from "./comet-ai.js";

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
        timeout: { type: "number", description: "Max wait time in ms (default: 15000 = 15s)" },
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
];

const server = new Server(
  { name: "comet-bridge", version: "2.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "comet_connect": {
        // Auto-start Comet with debug port (will restart if running without it)
        const startResult = await cometClient.startComet(9222);

        // Get all tabs and clean up - close all except one
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
          await cometClient.navigate("https://www.perplexity.ai/", true);
          await new Promise(resolve => setTimeout(resolve, 1500));
          return { content: [{ type: "text", text: `${startResult}\nConnected to Perplexity (cleaned ${pageTabs.length - 1} old tabs)` }] };
        }

        // No tabs at all - create a new one
        const newTab = await cometClient.newTab("https://www.perplexity.ai/");
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for page load
        await cometClient.connect(newTab.id);
        return { content: [{ type: "text", text: `${startResult}\nCreated new tab and navigated to Perplexity` }] };
      }

      case "comet_ask": {
        let prompt = args?.prompt as string;
        const timeout = (args?.timeout as number) || 15000; // Default 15s, use poll for longer tasks
        const newChat = (args?.newChat as boolean) || false;

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
          // Clean up extra tabs (fixes CDP state after agentic browsing)
          const targets = await cometClient.listTargets();
          const pageTabs = targets.filter(t => t.type === 'page');
          if (pageTabs.length > 1) {
            for (let i = 1; i < pageTabs.length; i++) {
              try { await cometClient.closeTab(pageTabs[i].id); } catch { /* ignore */ }
            }
          }

          // Fresh connect to remaining tab
          const freshTargets = await cometClient.listTargets();
          const mainTab = freshTargets.find(t => t.type === 'page');
          if (mainTab) {
            await cometClient.connect(mainTab.id);
          }

          // Navigate to Perplexity home
          await cometClient.navigate("https://www.perplexity.ai/", true);
          await new Promise(resolve => setTimeout(resolve, 1500));
        } else {
          // Not newChat - just ensure we're on Perplexity
          const tabs = await cometClient.listTabsCategorized();
          if (tabs.main) {
            await cometClient.connect(tabs.main.id);
          }

          const urlResult = await cometClient.evaluate('window.location.href');
          const currentUrl = urlResult.result.value as string;
          const isOnPerplexity = currentUrl?.includes('perplexity.ai');

          if (!isOnPerplexity) {
            await cometClient.navigate("https://www.perplexity.ai/", true);
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }

        // Capture old response state BEFORE sending prompt (for follow-up detection)
        const oldStateResult = await cometClient.evaluate(`
          (() => {
            const proseEls = document.querySelectorAll('[class*="prose"]');
            const lastProse = proseEls[proseEls.length - 1];
            return {
              count: proseEls.length,
              lastText: lastProse ? lastProse.innerText.substring(0, 100) : ''
            };
          })()
        `);
        const oldState = oldStateResult.result.value as { count: number; lastText: string };

        // Send the prompt
        await cometAI.sendPrompt(prompt);

        // Wait for completion
        const startTime = Date.now();
        const stepsCollected: string[] = [];
        let sawNewResponse = false;

        while (Date.now() - startTime < timeout) {
          await new Promise(resolve => setTimeout(resolve, 2000)); // Poll every 2s

          // Check if we have a NEW response (more prose elements or different text)
          const currentStateResult = await cometClient.evaluate(`
            (() => {
              const proseEls = document.querySelectorAll('[class*="prose"]');
              const lastProse = proseEls[proseEls.length - 1];
              return {
                count: proseEls.length,
                lastText: lastProse ? lastProse.innerText.substring(0, 100) : ''
              };
            })()
          `);
          const currentState = currentStateResult.result.value as { count: number; lastText: string };

          // Detect new response
          if (!sawNewResponse) {
            if (currentState.count > oldState.count ||
                (currentState.lastText && currentState.lastText !== oldState.lastText)) {
              sawNewResponse = true;
            }
          }

          const status = await cometAI.getAgentStatus();

          // Collect steps
          for (const step of status.steps) {
            if (!stepsCollected.includes(step)) {
              stepsCollected.push(step);
            }
          }

          // Task completed - return result directly (but only if we saw a NEW response)
          if (status.status === 'completed' && sawNewResponse) {
            return { content: [{ type: "text", text: status.response || 'Task completed (no response text extracted)' }] };
          }
        }

        // Still working after initial wait - return "in progress" (non-blocking)
        const finalStatus = await cometAI.getAgentStatus();
        let inProgressMsg = `Task in progress (${stepsCollected.length} steps so far).\n`;
        inProgressMsg += `Status: ${finalStatus.status.toUpperCase()}\n`;
        if (finalStatus.currentStep) {
          inProgressMsg += `Current: ${finalStatus.currentStep}\n`;
        }
        if (finalStatus.agentBrowsingUrl) {
          inProgressMsg += `Browsing: ${finalStatus.agentBrowsingUrl}\n`;
        }
        if (stepsCollected.length > 0) {
          inProgressMsg += `\nSteps:\n${stepsCollected.map(s => `  • ${s}`).join('\n')}\n`;
        }
        inProgressMsg += `\nUse comet_poll to check progress or comet_stop to cancel.`;

        return { content: [{ type: "text", text: inProgressMsg }] };
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
          output += `\nSteps:\n${status.steps.map(s => `  • ${s}`).join('\n')}\n`;
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

        // If no mode provided, show current mode
        if (!mode) {
          const result = await cometClient.evaluate(`
            (() => {
              // Try button group first (wide screen)
              const modes = ['Search', 'Research', 'Labs', 'Learn'];
              for (const mode of modes) {
                const btn = document.querySelector('button[aria-label="' + mode + '"]');
                if (btn && btn.getAttribute('data-state') === 'checked') {
                  return mode.toLowerCase();
                }
              }
              // Try dropdown (narrow screen) - look for the mode selector button
              const dropdownBtn = document.querySelector('button[class*="gap"]');
              if (dropdownBtn) {
                const text = dropdownBtn.innerText.toLowerCase();
                if (text.includes('search')) return 'search';
                if (text.includes('research')) return 'research';
                if (text.includes('labs')) return 'labs';
                if (text.includes('learn')) return 'learn';
              }
              return 'search';
            })()
          `);

          const currentMode = result.result.value as string;
          const descriptions: Record<string, string> = {
            search: 'Basic web search',
            research: 'Deep research with comprehensive analysis',
            labs: 'Analytics, visualizations, and coding',
            learn: 'Educational content and explanations'
          };

          let output = `Current mode: ${currentMode}\n\nAvailable modes:\n`;
          for (const [m, desc] of Object.entries(descriptions)) {
            const marker = m === currentMode ? "→" : " ";
            output += `${marker} ${m}: ${desc}\n`;
          }

          return { content: [{ type: "text", text: output }] };
        }

        // Switch mode
        const modeMap: Record<string, string> = {
          search: "Search",
          research: "Research",
          labs: "Labs",
          learn: "Learn",
        };
        const ariaLabel = modeMap[mode];
        if (!ariaLabel) {
          return {
            content: [{ type: "text", text: `Invalid mode: ${mode}. Use: search, research, labs, learn` }],
            isError: true,
          };
        }

        // Navigate to Perplexity first if not there
        const state = cometClient.currentState;
        if (!state.currentUrl?.includes("perplexity.ai")) {
          await cometClient.navigate("https://www.perplexity.ai/", true);
        }

        // Try both UI patterns: button group (wide) and dropdown (narrow)
        const result = await cometClient.evaluate(`
          (() => {
            // Strategy 1: Direct button (wide screen)
            const btn = document.querySelector('button[aria-label="${ariaLabel}"]');
            if (btn) {
              btn.click();
              return { success: true, method: 'button' };
            }

            // Strategy 2: Dropdown menu (narrow screen)
            // Find and click the dropdown trigger (button with current mode text)
            const allButtons = document.querySelectorAll('button');
            for (const b of allButtons) {
              const text = b.innerText.toLowerCase();
              if ((text.includes('search') || text.includes('research') ||
                   text.includes('labs') || text.includes('learn')) &&
                  b.querySelector('svg')) {
                b.click();
                return { success: true, method: 'dropdown-open', needsSelect: true };
              }
            }

            return { success: false, error: "Mode selector not found" };
          })()
        `);

        const clickResult = result.result.value as { success: boolean; method?: string; needsSelect?: boolean; error?: string };

        if (clickResult.success && clickResult.needsSelect) {
          // Wait for dropdown to open, then select the mode
          await new Promise(resolve => setTimeout(resolve, 300));
          const selectResult = await cometClient.evaluate(`
            (() => {
              // Look for dropdown menu items
              const items = document.querySelectorAll('[role="menuitem"], [role="option"], button');
              for (const item of items) {
                if (item.innerText.toLowerCase().includes('${mode}')) {
                  item.click();
                  return { success: true };
                }
              }
              return { success: false, error: "Mode option not found in dropdown" };
            })()
          `);
          const selectRes = selectResult.result.value as { success: boolean; error?: string };
          if (selectRes.success) {
            return { content: [{ type: "text", text: `Switched to ${mode} mode` }] };
          } else {
            return { content: [{ type: "text", text: `Failed: ${selectRes.error}` }], isError: true };
          }
        }

        if (clickResult.success) {
          return { content: [{ type: "text", text: `Switched to ${mode} mode` }] };
        } else {
          return {
            content: [{ type: "text", text: `Failed to switch mode: ${clickResult.error}` }],
            isError: true,
          };
        }
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

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : error}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
server.connect(transport);
