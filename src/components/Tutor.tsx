import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useLocation } from "react-router-dom";
import { ArrowUp, Eraser, KeyRound, Settings2, Sparkles, Square, X } from "lucide-react";
import { chatAi } from "../ai/chat";
import { DEFAULT_MODELS, isConfigured, providerLabel, useAi, useAiActive, type AiSettings, type Provider } from "../ai/settings";
import { chatSources, onSourcesChange, useChat } from "../chat/store";

const FALLBACK_SUGGESTIONS = ["What will I be able to build after this course?", "Where should I start if I already know HTTP?", "Explain what a backend does with an everyday example"];

function useSources() {
  // Re-render when a screen registers or leaves; the list is rebuilt on every render so labels stay fresh.
  useSyncExternalStore(onSourcesChange, () => chatSources().length);
  return chatSources();
}

type Key = Exclude<Provider, "none">;
const PROVIDERS: Key[] = ["anthropic", "openai", "azure"];

/** Connect a provider: the learner's own key, or one kept in .env on this computer when the app runs locally. */
function Setup({ onDone }: { onDone: () => void }) {
  const current = useAi((s) => s.settings);
  const serverKeys = useAi((s) => s.serverKeys);
  const canPersist = useAi((s) => s.canPersist);
  const configured = isConfigured(current);
  const [provider, setProvider] = useState<Key>(current.provider === "none" ? "anthropic" : current.provider);
  const [apiKey, setApiKey] = useState(current.viaServer ? "" : current.apiKey);
  const [model, setModel] = useState(current.model);
  const [endpoint, setEndpoint] = useState(current.azureEndpoint);
  const [deployment, setDeployment] = useState(current.azureDeployment);
  const [remember, setRemember] = useState(current.remember);
  const [state, setState] = useState<{ busy?: boolean; error?: string }>({});

  const draft: AiSettings = { ...current, provider, apiKey: apiKey.trim(), model: model.trim(), azureEndpoint: endpoint, azureDeployment: deployment, remember, viaServer: false };

  const connect = async (s: AiSettings) => {
    setState({ busy: true });
    try {
      // One tiny question proves the key, the model name and the network path before anything is saved.
      await chatAi(s, [{ role: "user", content: "Reply with the single word: ready" }], {}, () => {});
      const saved = await useAi.getState().save(s, { protection: "device" });
      if (!saved.ok) return setState({ error: saved.error });
      setState({});
      onDone();
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <form
      className="tutor-setup"
      onSubmit={(e) => {
        e.preventDefault();
        if (isConfigured(draft) && !state.busy) void connect(draft);
      }}
    >
      <span className="tutor-setup-icon">
        <KeyRound size={18} />
      </span>
      <h3>{configured ? "Tutor settings" : "Connect your AI key"}</h3>
      <p>
        The tutor reads the lesson you have open and answers questions about it. It uses your own API key, sent straight from this browser to the
        provider you choose.
      </p>

      <fieldset className="seg" aria-label="Provider">
        {PROVIDERS.map((p) => (
          <label key={p} className={p === provider ? "is-on" : undefined}>
            <input type="radio" name="provider" value={p} checked={p === provider} onChange={() => setProvider(p)} />
            {p === "anthropic" ? "Claude" : p === "openai" ? "OpenAI" : "Azure"}
          </label>
        ))}
      </fieldset>

      {serverKeys?.[provider] && (
        <button type="button" className="btn" disabled={state.busy} onClick={() => void connect({ ...draft, apiKey: "", viaServer: true })}>
          Use the {providerLabel(provider)} key in .env
        </button>
      )}

      <label className="field">
        <span>API key</span>
        <input type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={provider === "anthropic" ? "sk-ant-…" : "Paste your key"} />
      </label>

      {provider === "azure" ? (
        <>
          <label className="field">
            <span>Endpoint</span>
            <input type="url" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://your-resource.openai.azure.com" />
          </label>
          <label className="field">
            <span>Deployment name</span>
            <input value={deployment} onChange={(e) => setDeployment(e.target.value)} />
          </label>
        </>
      ) : (
        <label className="field">
          <span>
            Model <em>optional</em>
          </span>
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={DEFAULT_MODELS[provider]} spellCheck={false} />
        </label>
      )}

      <label className="check">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Remember on this device
      </label>

      {state.error && (
        <p className="tutor-error" role="alert">
          {state.error}
        </p>
      )}

      <div className="tutor-setup-actions">
        <button type="submit" className="btn is-primary" disabled={!isConfigured(draft) || state.busy}>
          {state.busy ? "Checking…" : "Connect and test"}
        </button>
        {configured && (
          <>
            <button type="button" className="btn" onClick={onDone}>
              Cancel
            </button>
            <button type="button" className="btn is-quiet" onClick={() => void useAi.getState().clear()}>
              Remove key
            </button>
          </>
        )}
      </div>

      <p className="tutor-fine">
        {canPersist
          ? "The key is encrypted before it is saved in this browser. It is never sent anywhere except the provider."
          : "This browser can't encrypt storage, so the key is kept only until you close the tab."}{" "}
        Each question includes the text of the lesson you are on.
      </p>
    </form>
  );
}

function Message({ role, content, error }: { role: "user" | "assistant"; content: string; error?: boolean }) {
  if (role === "user") return <div className="msg is-user">{content}</div>;
  if (error) return <div className="msg is-error">{content}</div>;
  return (
    <div className="msg is-ai">
      {content ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      ) : (
        <span className="typing" aria-label="Thinking">
          <i />
          <i />
          <i />
        </span>
      )}
    </div>
  );
}

/** The AI tutor: a panel docked beside the lesson that knows what is on screen. */
export function Tutor() {
  const { open, busy, messages } = useChat();
  const { setOpen, send, stop, clear } = useChat.getState();
  const active = useAiActive();
  const status = useAi((s) => s.status);
  const provider = useAi((s) => s.settings.provider);
  const route = useLocation().pathname;
  const sources = useSources();
  const [settings, setSettings] = useState(false);
  const [draft, setDraft] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages, open]);
  useEffect(() => {
    if (open && active && !settings) input.current?.focus();
  }, [open, active, settings]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;

  const suggestions = sources.flatMap((s) => s.suggestions ?? []).slice(0, 4);
  const submit = (text = draft) => {
    if (!text.trim() || busy) return;
    setDraft("");
    void send(text, route);
  };

  return (
    <aside className="tutor" aria-label="AI tutor">
      <header className="tutor-head">
        <span className="tutor-mark">
          <Sparkles size={15} />
        </span>
        <div>
          <b>Tutor</b>
          <span>{sources.length ? `Reading: ${sources.map((s) => s.label).join(" · ")}` : "Ask about this page"}</span>
        </div>
        {active && messages.length > 0 && (
          <button type="button" className="icon-btn" onClick={clear} aria-label="New chat" title="New chat">
            <Eraser size={16} />
          </button>
        )}
        {active && (
          <button type="button" className="icon-btn" onClick={() => setSettings(!settings)} aria-label="Tutor settings" title="Tutor settings" aria-pressed={settings}>
            <Settings2 size={16} />
          </button>
        )}
        <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Close tutor" title="Close (Esc)">
          <X size={17} />
        </button>
      </header>

      {status === "loading" ? (
        <div className="tutor-body">
          <span className="typing">
            <i />
            <i />
            <i />
          </span>
        </div>
      ) : !active || settings ? (
        <div className="tutor-body">
          <Setup onDone={() => setSettings(false)} />
        </div>
      ) : (
        <>
          <div className="tutor-body">
            {messages.length === 0 ? (
              <div className="tutor-intro">
                <p>Ask anything about what you are reading. The tutor can explain it another way, give an example, or quiz you.</p>
                <div className="chips">
                  {(suggestions.length ? suggestions : FALLBACK_SUGGESTIONS).map((q) => (
                    <button type="button" key={q} onClick={() => submit(q)}>
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m, i) => <Message key={i} {...m} />)
            )}
            <div ref={end} />
          </div>
          <form
            className="tutor-input"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <textarea
              ref={input}
              value={draft}
              rows={1}
              placeholder="Ask about this lesson…"
              aria-label="Your question"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            {busy ? (
              <button type="button" className="send" onClick={stop} aria-label="Stop" title="Stop">
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button type="submit" className="send" disabled={!draft.trim()} aria-label="Send" title="Send (Enter)">
                <ArrowUp size={17} />
              </button>
            )}
          </form>
          <p className="tutor-fine is-foot">{providerLabel(provider)} · AI can be wrong. Check anything important against the lesson.</p>
        </>
      )}
    </aside>
  );
}
