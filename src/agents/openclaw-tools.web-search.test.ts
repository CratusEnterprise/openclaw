import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { createCodeModeCatalogProjection } from "./code-mode-catalog.js";
import { createOpenClawToolsAsync } from "./openclaw-tools.js";
import { buildConfiguredAgentSystemPrompt } from "./system-prompt-config.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
} from "./tool-search-catalog.js";

// mock-isolation: Exercise real assembly without loading external plugins or credentials.
vi.mock("./openclaw-plugin-tools.js", () => ({ resolveOpenClawPluginToolsForOptions: () => [] }));
// mock-isolation: Empty provider inventory represents a fresh installation with no search setup.
vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: () => [],
  resolveRuntimeWebSearchProviders: () => [],
}));

afterEach(() => vi.restoreAllMocks());

describe("unconfigured web search tool surface", () => {
  it.each([
    { label: "unconfigured", config: {}, expected: false, fact: false },
    {
      label: "configured",
      config: { tools: { web: { search: { provider: "brave" } } } },
      expected: true,
      fact: true,
    },
    {
      label: "explicit key-free",
      config: { tools: { web: { search: { provider: "duckduckgo" } } } },
      expected: true,
      fact: true,
    },
    {
      label: "disabled",
      config: { tools: { web: { search: { enabled: false } } } },
      expected: false,
      fact: undefined,
    },
  ])("prepares $label search in the async runtime factory", async ({ config, expected, fact }) => {
    const onWebSearchConfiguration = vi.fn();
    const tools = await createOpenClawToolsAsync({
      config,
      disableMessageTool: true,
      disablePluginTools: true,
      wrapBeforeToolCallHook: false,
      onWebSearchConfiguration,
    });
    expect(tools.some((tool) => tool.name === "web_search")).toBe(expected);
    if (fact === undefined) {
      expect(onWebSearchConfiguration).not.toHaveBeenCalled();
    } else {
      expect(onWebSearchConfiguration).toHaveBeenCalledExactlyOnceWith(fact);
    }
  });

  it.each(["full", "minimal"] as const)(
    "gives concise missing-setup context in %s prompts without a callable",
    (promptMode) => {
      const render = (webSearchUnconfigured: boolean, capabilityToolNames: string[] = []) =>
        buildConfiguredAgentSystemPrompt({
          config: {},
          workspaceDir: "/workspace",
          tools: [],
          capabilityToolNames,
          webSearchUnconfigured,
          promptMode,
        });
      const prompt = render(true);
      expect(prompt).toContain("Web search is supported but not configured.");
      expect(prompt).toContain("openclaw configure --section web");
      expect(prompt).toContain("Settings → Ask OpenClaw");
      expect(prompt).not.toContain("- web_search:");
      expect(render(false)).not.toContain("Web search is supported but not configured.");
      expect(render(true, ["web_search"])).not.toContain(
        "Web search is supported but not configured.",
      );
    },
  );

  it("excludes unconfigured search from initial tools, discovery, and Code Mode", () => {
    const tools = createOpenClawCodingTools({
      config: {},
      workspaceDir: "/tmp/openclaw-web-search-test",
      disableMessageTool: true,
      wrapBeforeToolCallHook: false,
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: false,
      },
    });
    const catalogRef = createToolSearchCatalogRef();
    registerHeadlessToolSearchCatalog({ catalogRef, tools });
    const entries = catalogRef.current?.entries ?? [];
    expect.soft(tools.map((tool) => tool.name)).not.toContain("web_search");
    expect.soft(entries.map((entry) => entry.name)).not.toContain("web_search");
    expect(createCodeModeCatalogProjection(entries).byCallableName.has("web_search")).toBe(false);
    expect(tools.map((tool) => tool.name)).toContain("web_fetch");
  });
});
