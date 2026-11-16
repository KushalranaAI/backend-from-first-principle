import Anthropic from "@anthropic-ai/sdk";
import { SERVER_HEADERS, anthropicClient, postCompletion, providerError, serverPath } from "./client";
import { DEFAULT_MODELS, type AiSettings } from "./settings";

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

const SYSTEM = `You are the tutor built into "Backend from first principles", a self-paced course that teaches backend engineering by starting from the problem each idea solves. It has 28 lessons in six parts (orientation, the request, data, production, scale, engineering practice). Across the course the learner builds Linkbox, a bookmarks API, in Node.js with Fastify, Postgres and Redis.

The learner has one screen open. Everything you know about it is in the "Screen context" JSON below: usually the full text of the lesson they are reading.

How to help:
- Answer the question they asked, grounded in the lesson on screen. If the lesson doesn't cover it, say so and name the lesson that does when you know it.
- Teach the reason before the mechanism. Start from what would break without the idea, then show how it works, then name the trade-off.
- Make it concrete. Use an everyday comparison when it helps, and a short example (an HTTP exchange, a few lines of JavaScript or SQL, a curl command) when the question is about how something works.
- When they ask to be quizzed, ask one question at a time, wait for their answer, then say plainly what was right and what was missing before the next question.
- For "Try it" exercises and Linkbox build steps, give hints and point at the relevant part of the lesson first. Write the full solution only when they ask for it.
- Security questions are part of the course. Explain how an attack works at the level the lesson does, and always pair it with the defence.
- Keep answers short: a few sentences or a short list, unless they ask for depth. Define a term the first time you use it. Markdown is rendered.
- If the question has nothing to do with backend engineering or this course, answer in a sentence and bring them back to the lesson.`;

/** Far above the longest lesson (about 50,000 characters), so lesson text is never cut. */
const MAX_CONTEXT_CHARS = 200_000;

function contextText(context: unknown): string {
  const json = JSON.stringify(context ?? {});
  return json.length > MAX_CONTEXT_CHARS ? json.slice(0, MAX_CONTEXT_CHARS) + ' ...(truncated)"}' : json;
}

/** Read an OpenAI-style server-sent-event stream, calling onDelta with each piece of text. */
async function streamOpenAi(url: string, headers: Record<string, string>, body: object, onDelta: (t: string) => void, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!res.ok || !res.body) throw providerError(res.status, await res.text());
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let full = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const piece = JSON.parse(data)?.choices?.[0]?.delta?.content;
        if (piece) {
          full += piece;
          onDelta(piece);
        }
      } catch {
        /* partial JSON line - ignore */
      }
    }
  }
  return full;
}

/** A readable message for the errors a learner can actually fix. */
function friendly(e: unknown): unknown {
  if (e instanceof Anthropic.AuthenticationError) return new Error("That API key was rejected. Check the key and try again.");
  if (e instanceof Anthropic.RateLimitError) return new Error("The provider is rate limiting this key. Wait a moment and try again.");
  if (e instanceof Anthropic.APIConnectionError && !(e instanceof Anthropic.APIUserAbortError)) return new Error("Couldn't reach the AI provider. Check your connection.");
  return e;
}

/**
 * Ask the configured provider a question. `context` is what is on the learner's screen right now; it is rebuilt for
 * every question and never includes the API key. Text is streamed through `onDelta` where the provider allows.
 */
export async function chatAi(s: AiSettings, history: ChatMsg[], context: unknown, onDelta: (t: string) => void, signal?: AbortSignal): Promise<string> {
  const system = `${SYSTEM}\n\nScreen context (JSON):\n${contextText(context)}`;

  if (s.provider === "anthropic") {
    try {
      // The beta endpoint is used only for server-side fallback: if the model declines a question (the security
      // lesson can trip a classifier), the API retries on the model's default fallback inside the same request.
      const stream = anthropicClient(s).beta.messages.stream(
        {
          model: s.model || DEFAULT_MODELS.anthropic,
          max_tokens: 16000,
          // The lesson text is identical for every question in a conversation, so cache it.
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          messages: history,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal },
      );
      stream.on("text", onDelta);
      const final = await stream.finalMessage();
      if (final.stop_reason === "refusal") throw new Error("The model declined to answer this one. Try rephrasing the question.");
      return final.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    } catch (e) {
      throw friendly(e);
    }
  }

  const messages = [{ role: "system", content: system }, ...history];
  if (s.provider === "openai") {
    const body = { model: s.model || DEFAULT_MODELS.openai, messages };
    if (s.viaServer) return streamOpenAi(serverPath("openai/v1/chat/completions"), SERVER_HEADERS, body, onDelta, signal);
    const headers = { authorization: `Bearer ${s.apiKey}` };
    try {
      return await streamOpenAi("https://api.openai.com/v1/chat/completions", headers, body, onDelta, signal);
    } catch (e) {
      if (!(e instanceof TypeError) || signal?.aborted) throw e;
      const text = await postCompletion("https://api.openai.com/v1/chat/completions", headers, body, true, signal); // network/CORS → local relay
      onDelta(text);
      return text;
    }
  }
  if (s.provider === "azure") {
    if (s.viaServer) {
      const text = await postCompletion(serverPath("azure/chat/completions"), SERVER_HEADERS, { messages }, false, signal);
      onDelta(text);
      return text;
    }
    const base = s.azureEndpoint.trim().replace(/\/+$/, "");
    const url = `${base}/openai/deployments/${encodeURIComponent(s.azureDeployment.trim())}/chat/completions?api-version=${encodeURIComponent(s.azureApiVersion || "2024-10-21")}`;
    const text = await postCompletion(url, { "api-key": s.apiKey }, { messages }, true, signal);
    onDelta(text);
    return text;
  }
  throw new Error("No AI provider is configured.");
}
