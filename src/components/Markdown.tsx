import { memo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { Link } from "react-router-dom";
import { Check, Copy, Sparkles } from "lucide-react";
import { lessonLink, slugify } from "../lib/parse";

type HastNode = { type: string; value?: string; children?: HastNode[]; position?: { start: { offset?: number } } };

const textOf = (n?: HastNode): string => (n ? (n.value ?? (n.children ?? []).map(textOf).join("")) : "");

export function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() =>
        navigator.clipboard?.writeText(text.replace(/\n$/, "")).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

type Props = {
  source: string;
  /** Checklist state for "- [ ]" items; without it they render read-only. */
  tasks?: { ticks: Record<string, number>; toggle: (id: string, on: boolean) => void };
  /** Distinguishes checkboxes when one lesson is rendered as several Markdown pieces. */
  taskKey?: string;
  /** Adds an "Explain" button to code blocks that hands the code to the tutor. */
  onExplain?: (code: string) => void;
};

/** Lesson Markdown: GitHub-flavoured, raw HTML allowed (our own content: <details> answers), links routed in-app. */
export const Markdown = memo(function Markdown({ source, tasks, taskKey = "", onExplain }: Props) {
  const heading =
    (Tag: "h2" | "h3") =>
    ({ node, children }: { node?: unknown; children?: ReactNode }) => <Tag id={slugify(textOf(node as HastNode))}>{children}</Tag>;

  const components: Components = {
    h2: heading("h2"),
    h3: heading("h3"),
    a({ href = "", children }) {
      const lesson = lessonLink(href);
      if (lesson) {
        const [slug, hash] = lesson.split("#");
        return <Link to={hash ? `/${slug}?at=${hash}` : `/${slug}`}>{children}</Link>;
      }
      if (href.startsWith("#")) {
        return (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault();
              scrollToId(href.slice(1));
            }}
          >
            {children}
          </a>
        );
      }
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
    pre({ node, children }) {
      const text = textOf(node as HastNode);
      return (
        <div className="code">
          <pre>{children}</pre>
          <div className="code-actions">
            {onExplain && text.trim().split("\n").length > 2 && (
              <button type="button" onClick={() => onExplain(text)}>
                <Sparkles size={13} />
                Explain
              </button>
            )}
            <CopyButton text={text} />
          </div>
        </div>
      );
    },
    table({ children }) {
      return (
        <div className="table">
          <table>{children}</table>
        </div>
      );
    },
    input({ node, type, checked }) {
      if (type !== "checkbox") return <input type={type} />;
      const id = `${taskKey}:${(node as HastNode | undefined)?.position?.start.offset ?? ""}`;
      if (!tasks) return <input type="checkbox" checked={!!checked} disabled />;
      return <input type="checkbox" aria-label="Done" checked={!!tasks.ticks[id]} onChange={(e) => tasks.toggle(id, e.target.checked)} />;
    },
  };

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={components}>
      {source}
    </ReactMarkdown>
  );
});
