// Registers a linked inference server as a Pi provider routed through T3's gateway. Pi resolves
// "$T3_GATEWAY_TOKEN" from the environment itself (1.5 provider-composer), so the token never
// lands in argv, settings, or ~/.pi.
export const PI_T3_GATEWAY_EXTENSION_FILENAME = "pi-t3-gateway-extension.ts";

export const T3_GATEWAY_URL_ENV = "T3_GATEWAY_URL";
export const T3_GATEWAY_TOKEN_ENV = "T3_GATEWAY_TOKEN";
export const T3_GATEWAY_PROVIDER_ENV = "T3_GATEWAY_PROVIDER";
export const T3_GATEWAY_MODELS_ENV = "T3_GATEWAY_MODELS";

/** Self-contained so it can sit in both T3's full extension and the gateway-only one. */
export const PI_T3_GATEWAY_PROVIDER_SNIPPET = `\
function registerT3GatewayProvider(pi: ExtensionAPI) {
  const baseUrl = process.env[${JSON.stringify(T3_GATEWAY_URL_ENV)}];
  const name = process.env[${JSON.stringify(T3_GATEWAY_PROVIDER_ENV)}];
  const modelsJson = process.env[${JSON.stringify(T3_GATEWAY_MODELS_ENV)}];
  if (!baseUrl || !name || !modelsJson || !process.env[${JSON.stringify(T3_GATEWAY_TOKEN_ENV)}]) return;
  let models: unknown;
  try {
    models = JSON.parse(modelsJson);
  } catch {
    return;
  }
  if (!Array.isArray(models) || models.length === 0) return;
  pi.registerProvider(name, {
    baseUrl,
    apiKey: ${JSON.stringify(`$${T3_GATEWAY_TOKEN_ENV}`)},
    api: "openai-completions",
    models,
  });
}
`;

export const PI_T3_GATEWAY_EXTENSION_SOURCE = `\
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

${PI_T3_GATEWAY_PROVIDER_SNIPPET}
export default function t3GatewayExtension(pi: ExtensionAPI) {
  registerT3GatewayProvider(pi);
}
`;
