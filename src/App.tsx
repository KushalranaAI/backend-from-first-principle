import { useEffect, useRef, useState } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { Menu, Moon, Search as SearchIcon, Sparkles, Sun } from "lucide-react";
import { bySlug } from "./course";
import { useChat } from "./chat/store";
import { useTheme } from "./theme";
import { Home } from "./pages/Home";
import { Lesson } from "./pages/Lesson";
import { Search } from "./components/Search";
import { Sidebar } from "./components/Sidebar";
import { Tutor } from "./components/Tutor";
import { Credit } from "./components/Credit";

export function App() {
  const [searching, setSearching] = useState(false);
  const [menu, setMenu] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const tutorOpen = useChat((s) => s.open);
  const { pathname } = useLocation();
  const entry = bySlug.get(pathname.slice(1));
  const bar = useRef<HTMLDivElement>(null);

  // Ctrl/⌘+K or "/" opens search; Ctrl/⌘+J opens the tutor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest?.("input, textarea, [contenteditable]");
      const mod = e.ctrlKey || e.metaKey;
      if ((e.key === "k" && mod) || (e.key === "/" && !typing)) {
        e.preventDefault();
        setSearching(true);
      } else if (e.key === "j" && mod) {
        e.preventDefault();
        useChat.getState().setOpen(!useChat.getState().open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Reading progress: a thin line under the top bar, driven straight from scroll (no re-render per frame).
  useEffect(() => {
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      bar.current?.style.setProperty("--read", max > 0 ? String(Math.min(1, window.scrollY / max)) : "0");
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [pathname]);

  return (
    <div className={`app${tutorOpen ? " has-tutor" : ""}`}>
      <Sidebar open={menu} onClose={() => setMenu(false)} onSearch={() => setSearching(true)} />

      <div className="main">
        <header className="bar">
          <button type="button" className="icon-btn bar-menu" onClick={() => setMenu(true)} aria-label="Open course outline">
            <Menu size={19} />
          </button>
          <p className="crumb">
            {entry ? (
              <>
                <span>{entry.lesson.part}</span>
                <b>
                  {entry.lesson.num} · {entry.lesson.title}
                </b>
              </>
            ) : (
              <b>Overview</b>
            )}
          </p>
          <button type="button" className="icon-btn bar-search" onClick={() => setSearching(true)} aria-label="Search">
            <SearchIcon size={18} />
          </button>
          <button type="button" className="icon-btn" onClick={toggleTheme} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} title="Theme">
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button type="button" className={`btn ask${tutorOpen ? " is-on" : ""}`} onClick={() => useChat.getState().setOpen(!tutorOpen)} aria-pressed={tutorOpen} title="Ask AI (Ctrl J)">
            <Sparkles size={15} />
            <span>Ask AI</span>
          </button>
          <div className="read" ref={bar} aria-hidden="true" />
        </header>

        <div className="page" key={pathname}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/:slug" element={<Lesson />} />
          </Routes>
        </div>

        <Credit />
      </div>

      <Tutor />
      {searching && <Search onClose={() => setSearching(false)} />}
    </div>
  );
}
