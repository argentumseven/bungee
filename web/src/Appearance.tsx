import { useEffect, useLayoutEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

type Appearance = "system" | "light" | "dark";
const storageKey = "bungee.appearance";
const valid = (value: string | null): Appearance =>
  value === "light" || value === "dark" ? value : "system";
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
function readAppearance(): Appearance {
  try {
    return valid(localStorage.getItem(storageKey));
  } catch {
    return "system";
  }
}
function applyAppearance(appearance: Appearance) {
  const resolved = appearance === "system"
    ? systemTheme.matches ? "dark" : "light"
    : appearance;
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", resolved === "dark" ? "#10141e" : "#f7f8fa");
}
// Apply a saved choice before React renders either the sign-in or dashboard.
applyAppearance(readAppearance());

export function useAppearance() {
  const [appearance, setAppearance] = useState<Appearance>(readAppearance);
  const [warning, setWarning] = useState("");
  useLayoutEffect(() => {
    applyAppearance(appearance);
    const changed = () => applyAppearance(appearance);
    systemTheme.addEventListener("change", changed);
    return () => systemTheme.removeEventListener("change", changed);
  }, [appearance]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null) {
        setAppearance(readAppearance());
        setWarning("");
      }
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  function choose(value: Appearance) {
    setAppearance(value);
    try {
      localStorage.setItem(storageKey, value);
      setWarning("");
    } catch {
      setWarning("Appearance applies to this visit. Browser storage is unavailable.");
    }
  }
  return { appearance, choose, warning };
}

export function AppearanceControl({ appearance, choose, warning }: ReturnType<typeof useAppearance>) {
  const Icon = appearance === "system" ? Monitor : appearance === "dark" ? Moon : Sun;
  return (
    <div className="appearance">
      <label className="appearance-control">
        <Icon size={15} aria-hidden="true" />
        <span className="sr-only">Appearance</span>
        <select value={appearance} onChange={(event) => choose(valid(event.target.value))}>
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      {warning && <small className="appearance-warning" role="status">{warning}</small>}
    </div>
  );
}
