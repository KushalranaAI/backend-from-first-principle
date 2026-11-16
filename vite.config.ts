import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { lessonMeta } from "./src/lib/parse";
import { createAiServerHandler, serverKeys } from "./server/ai-relay";

const CONTENT = resolve(__dirname, "content");

/**
 * `virtual:course` exports the lesson index (front matter, headings, word counts) without the lesson bodies,
 * so the home page and search load instantly and each lesson's text is fetched only when it is opened.
 */
function courseIndex(): Plugin {
  const id = "\0virtual:course";
  return {
    name: "course-index",
    resolveId: (source) => (source === "virtual:course" ? id : undefined),
    load(source) {
      if (source !== id) return;
      const files = readdirSync(CONTENT).filter((f) => /^\d\d-.*\.md$/.test(f)).sort();
      files.forEach((f) => this.addWatchFile(resolve(CONTENT, f)));
      const lessons = files.map((f) => lessonMeta(f, readFileSync(resolve(CONTENT, f), "utf8")));
      return `export default ${JSON.stringify(lessons)};`;
    },
    handleHotUpdate({ file, server }) {
      if (file.startsWith(CONTENT)) {
        const mod = server.moduleGraph.getModuleById(id);
        if (mod) server.moduleGraph.invalidateModule(mod);
      }
    },
  };
}

/**
 * Dev-only relay for AI calls the browser can't make directly (CORS, mainly Azure OpenAI). It forwards only to
 * known AI provider hosts, never stores or logs the key, and runs on your own machine.
 */
function aiProxy(): Plugin {
  const allowed = (host: string) =>
    host === "api.openai.com" || host === "api.anthropic.com" || /\.openai\.azure\.com$/.test(host) || /\.cognitiveservices\.azure\.com$/.test(host) || /\.services\.ai\.azure\.com$/.test(host);
  return {
    name: "bfp-ai-proxy",
    configureServer(server) {
      server.middlewares.use("/api/ai-proxy", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", async () => {
          try {
            const { url, headers, body } = JSON.parse(raw);
            const target = new URL(url);
            if (target.protocol !== "https:" || !allowed(target.hostname)) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: { message: `Refusing to relay to ${target.hostname}: only AI provider hosts are allowed.` } }));
              return;
            }
            const upstream = await fetch(target, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
            res.statusCode = upstream.status;
            res.setHeader("content-type", "application/json");
            res.end(await upstream.text());
          } catch (e) {
            res.statusCode = 502;
            res.end(JSON.stringify({ error: { message: String(e) } }));
          }
        });
      });
    },
  };
}

/**
 * Dev-only: AI keys kept in a `.env` file on this computer. The relay attaches them to provider requests here, so
 * they never reach the browser. They are read with loadEnv and deliberately NOT put in `define` or a VITE_ variable,
 * which would bake them into the public bundle.
 */
function aiServerKeys(): Plugin {
  return {
    name: "bfp-ai-server-keys",
    configureServer(server) {
      const env = loadEnv(server.config.mode, server.config.envDir || server.config.root, "");
      server.middlewares.use("/api/ai-server", createAiServerHandler(env));
      server.httpServer?.once("listening", () => {
        const found = Object.entries(serverKeys(env)).filter(([, ok]) => ok).map(([k]) => k);
        console.log(found.length ? `  AI keys from .env: ${found.join(", ")} (kept on this computer, never sent to the browser)` : "  No AI keys in .env (optional: copy .env.example to .env)");
      });
    },
  };
}

/**
 * Production-only Content-Security-Policy. The saved AI key is encrypted, but a script running inside the page could
 * still ask the browser to use it, so the page may only run this app's own scripts and only talk to the AI providers.
 */
function contentSecurityPolicy(): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // React sets inline style attributes
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://api.openai.com https://api.anthropic.com https://*.openai.azure.com https://*.cognitiveservices.azure.com https://*.services.ai.azure.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join("; ");
  return {
    name: "bfp-csp",
    apply: "build",
    transformIndexHtml: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: csp }, injectTo: "head-prepend" }],
  };
}

// `base: "./"` keeps the build portable: GitHub Pages, any static host, or a local folder.
export default defineConfig({
  base: "./",
  plugins: [react(), courseIndex(), aiProxy(), aiServerKeys(), contentSecurityPolicy()],
  server: { port: 5180 },
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // Libraries in their own long-cached chunks, so a content edit only changes the small app chunk.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(id)) return "react";
          if (id.includes("@anthropic-ai")) return "anthropic";
          if (id.includes("lucide-react")) return "icons";
          if (id.includes("@fontsource")) return undefined;
          return "markdown";
        },
      },
    },
  },
  test: { include: ["src/**/*.test.ts"] },
} as never);
