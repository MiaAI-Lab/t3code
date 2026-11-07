import {
  InferenceServerId,
  ProviderDriverKind,
  type InferenceServerSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectLocalUsageModels,
  localUsageModelCost,
  normalizeProviderAccentColor,
  providerAccentForegroundColor,
  providerInstanceInferenceLabel,
  providerInstanceInitials,
  shouldShowInstanceBadge,
} from "./providerInstanceDisplay.ts";

const codex = ProviderDriverKind.make("codex");
const acpRegistry = ProviderDriverKind.make("acpRegistry");

describe("providerInstanceInitials", () => {
  it("treats punctuation as a word break but keeps apostrophes between letters", () => {
    expect(providerInstanceInitials("Codex (hub)")).toBe("CH");
    expect(providerInstanceInitials("work_codex")).toBe("WC");
    expect(providerInstanceInitials("Theo's Codex")).toBe("TC");
    expect(providerInstanceInitials("Codex 'hub'")).toBe("CH");
    expect(providerInstanceInitials("‘hub’")).toBe("HU");
    expect(providerInstanceInitials("(hub)")).toBe("HU");
  });

  it("keeps an emoji whole instead of splitting its surrogate pair", () => {
    expect(providerInstanceInitials("😀 Work")).toBe("😀W");
    expect(providerInstanceInitials("😀")).toBe("😀");
  });
});

describe("normalizeProviderAccentColor", () => {
  // regression: #9899 a non-hex accent must not render as the account badge color
  it("rejects a non-hex value", () => {
    expect(normalizeProviderAccentColor("blue")).toBeUndefined();
  });
});

describe("providerAccentForegroundColor", () => {
  it.each([
    ["#b5f23d", "#000000"],
    ["#2563eb", "#ffffff"],
    ["#777777", "#000000"],
  ])("chooses the higher WCAG contrast foreground for %s", (accent, foreground) => {
    expect(providerAccentForegroundColor(accent)).toBe(foreground);
  });
});

describe("shouldShowInstanceBadge", () => {
  it("hides badges for distinct ACP agents sharing the registry driver", () => {
    const mistral = { driverKind: acpRegistry, acpRegistryAgentId: "mistral-vibe", enabled: true };
    const devin = { driverKind: acpRegistry, acpRegistryAgentId: "devin", enabled: true };
    expect(shouldShowInstanceBadge(mistral, [mistral, devin])).toBe(false);
    expect(shouldShowInstanceBadge(devin, [mistral, devin])).toBe(false);
  });

  it("distinguishes registry instances whose agent identity is unavailable", () => {
    const entry = { driverKind: acpRegistry, enabled: true };
    expect(shouldShowInstanceBadge(entry, [entry, { ...entry }])).toBe(true);
  });

  it("shows the badge when the entry has an accent color", () => {
    const entry = { driverKind: codex, accentColor: "#ff8800", enabled: true };
    expect(shouldShowInstanceBadge(entry, [entry])).toBe(true);
  });

  it("ignores a non-hex accent color", () => {
    const entry = { driverKind: codex, accentColor: "blue", enabled: true };
    expect(shouldShowInstanceBadge(entry, [entry])).toBe(false);
  });

  it("shows the badge when two entries share a driver, even without an accent", () => {
    const first = { driverKind: codex, accentColor: undefined, enabled: true };
    const second = { driverKind: codex, accentColor: undefined, enabled: true };
    expect(shouldShowInstanceBadge(first, [first, second])).toBe(true);
  });

  it("ignores disabled siblings for enabled instances while distinguishing historical owners", () => {
    const enabled = { driverKind: codex, enabled: true };
    const disabled = { driverKind: codex, enabled: false };

    expect(shouldShowInstanceBadge(enabled, [enabled, disabled])).toBe(false);
    expect(shouldShowInstanceBadge(disabled, [enabled, disabled])).toBe(true);
    expect(shouldShowInstanceBadge(disabled, [disabled, { ...disabled }])).toBe(true);
    expect(shouldShowInstanceBadge(disabled, [disabled])).toBe(false);
  });
});

describe("providerInstanceInferenceLabel", () => {
  const rtx = InferenceServerId.make("rtx");
  const server = (patch: Partial<InferenceServerSnapshot> = {}): InferenceServerSnapshot => ({
    id: rtx,
    displayName: "rtx",
    baseUrl: "http://localhost:8888/v1",
    enabled: true,
    status: "ready",
    checkedAt: null,
    models: [],
    ...patch,
  });

  it("names the linked server and its status, falling back to the manual mark", () => {
    const linked = { inferenceServerId: rtx };
    expect(providerInstanceInferenceLabel("Pi", linked, [server()])).toBe("Pi · rtx · Ready");
    expect(providerInstanceInferenceLabel("Pi", linked, [server({ status: "unreachable" })])).toBe(
      "Pi · rtx · Unreachable",
    );
    expect(providerInstanceInferenceLabel("Pi", linked, [server({ enabled: false })])).toBe(
      "Pi · rtx · Disabled",
    );
    expect(providerInstanceInferenceLabel("Pi", { ...linked, inference: "local" }, [])).toBe(
      "Pi · Local",
    );
    expect(providerInstanceInferenceLabel("Pi", linked, null)).toBe("Pi");
    expect(providerInstanceInferenceLabel("Codex", {}, [server()])).toBe("Codex");
  });
});

describe("localUsageModelCost", () => {
  const model = (slug: string) => ({ slug, name: slug, isCustom: false, capabilities: null });
  const models = collectLocalUsageModels([
    {
      inferenceServers: [
        { id: InferenceServerId.make("rtx"), enabled: true, models: [{ id: "GLM-5.3-Flash" }] },
        { id: InferenceServerId.make("old"), enabled: false, models: [{ id: "qwen3" }] },
      ],
      providers: [
        { inference: "local", models: [model("llama3")] },
        { inferenceServerId: InferenceServerId.make("old"), models: [model("mistral")] },
        { models: [model("gpt-5")] },
      ],
      priceOverrides: { "glm-5.3-flash": {} },
      modelAliases: undefined,
    },
  ]);

  it("marks local models, matching a provider prefix, and estimates only priced ones", () => {
    expect(localUsageModelCost("glm-5.3-flash", models)).toBe("estimate");
    expect(localUsageModelCost("t3-rtx/GLM-5.3-Flash", models)).toBe("local");
    expect(localUsageModelCost("llama3", models)).toBe("local");
    expect(localUsageModelCost("qwen3", models)).toBeNull();
    expect(localUsageModelCost("mistral", models)).toBeNull();
    expect(localUsageModelCost("gpt-5", models)).toBeNull();
  });
});
