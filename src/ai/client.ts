import Anthropic from "@anthropic-ai/sdk";
import type { AiSettings } from "./settings";

/** Headers the local relay requires; a custom header forces a CORS preflight that other websites can't pass. */
export const SERVER_HEADERS = { "x-bfp": "1" };
export const serverPath = (rest: string) => `./api/ai-server/${rest}`;

/** An Anthropic client: direct with the learner's own key, or pointed at the local relay, which holds the key. */
export function anthropicClient(s: AiSettings): Anthropic {
  if (s.viaServer) {
    const base = new URL("./api/ai-server/anthropic", typeof document !== "undefined" ? document.baseURI : "http://localhost/").href;
    return new Anthropic({ apiKey: "managed-by-server", baseURL: base, defaultHeaders: SERVER_HEADERS, dangerouslyAllowBrowser: true, maxRetries: 1 });
  }
  return new Anthropic({ apiKey: s.apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
}

/** Turn a failed provider response into a short readable error. */
export function providerError(status: number, text: string): Error {
  let msg = text;
  try {
    msg = JSON.parse(text)?.error?.message ?? text;
  } catch {
    /* not JSON */
  }
  return new Error(`${status}: ${msg.slice(0, 300)}`);
}

/** POST to an OpenAI-style chat-completions endpoint (optionally through the local relay) and return the reply text. */
export async function postCompletion(url: string, headers: Record<string, string>, body: object, viaProxy: boolean, signal?: AbortSignal): Promise<string> {
  const init: RequestInit = viaProxy
    ? { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ url, headers, body }) }
    : { method: "POST", signal, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
  const res = await fetch(viaProxy ? "./api/ai-proxy" : url, init);
  const text = await res.text();
  if (!res.ok) throw providerError(res.status, text);
  const content = JSON.parse(text)?.choices?.[0]?.message?.content;
  if (!content) throw new Error("The AI returned an empty answer.");
  return content;
}
