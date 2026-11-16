import { useCallback, useEffect, useState } from "react";

type Theme = "light" | "dark";
const KEY = "bfp:theme";

const system = (): Theme => (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

/** Follows the system until the learner picks a theme; the choice is remembered in this browser. */
export function applyStoredTheme() {
  const t = stored();
  if (t) document.documentElement.dataset.theme = t;
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => stored() ?? system());

  // Keep following the system while there is no explicit choice.
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => !stored() && setTheme(system());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const toggle = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* the choice just won't persist */
    }
    setTheme(next);
  }, [theme]);

  return [theme, toggle];
}
