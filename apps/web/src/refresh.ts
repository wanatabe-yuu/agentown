import { t } from "./i18n.ts";

/**
 * Reloading when the browser has no reload button (the app added to an
 * iPhone's home screen): pull down from the top of whatever you are looking
 * at, and a notice when a newer version of the app has been deployed.
 */

const PULL = 80; // px of pull that reloads
const standalone = () =>
  (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia("(display-mode: standalone)").matches;

/** Somewhere a downward drag means something else: the 3D office, a computer's screen, a text field, a map. */
const OWN_GESTURES = "canvas, .computer-screen, input, textarea, select, [contenteditable], .no-pull";

function atTop(el: Element | null): boolean {
  for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
    if (n.scrollTop > 0) return false;
  }
  return (document.scrollingElement?.scrollTop ?? 0) <= 0;
}

function pill(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "pull-refresh";
  el.setAttribute("role", "status");
  document.body.appendChild(el);
  return el;
}

export function installPullToRefresh() {
  if (!standalone() || !("ontouchstart" in window)) return;
  let startY = 0;
  let startX = 0;
  let pulling = false;
  let dy = 0;
  let el: HTMLDivElement | null = null;
  const show = (d: number) => {
    el ??= pill();
    const ready = d >= PULL;
    el.textContent = ready ? t("Release to reload") : t("Pull to reload");
    el.classList.toggle("ready", ready);
    el.style.transform = `translate(-50%, ${Math.min(d, PULL * 1.4) * 0.6}px)`;
    el.style.opacity = String(Math.min(1, d / PULL));
  };
  const hide = () => {
    el?.remove();
    el = null;
  };
  document.addEventListener("touchstart", (e) => {
    const target = e.target as Element;
    pulling = e.touches.length === 1 && !target.closest(OWN_GESTURES) && atTop(target);
    startY = e.touches[0]!.clientY;
    startX = e.touches[0]!.clientX;
    dy = 0;
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (!pulling) return;
    const y = e.touches[0]!.clientY - startY;
    const x = Math.abs(e.touches[0]!.clientX - startX);
    // Sideways, upwards, or the content scrolled after all: not a pull.
    if (y < 0 || x > y || !atTop(e.target as Element)) {
      pulling = false;
      return hide();
    }
    dy = y;
    if (dy > 10) show(dy);
  }, { passive: true });
  document.addEventListener("touchend", () => {
    if (pulling && dy >= PULL) {
      show(dy);
      el!.textContent = t("Reloading…");
      location.reload();
      return;
    }
    pulling = false;
    hide();
  });
  document.addEventListener("touchcancel", () => {
    pulling = false;
    hide();
  });
}

/** The script this page runs, so a deploy (new hashed bundle) can be noticed. */
const mainScript = () => [...document.scripts].map((s) => s.src).find((s) => /\/assets\/index-[^/]+\.js$/.test(s)) ?? null;

export function watchForNewVersion() {
  const mine = mainScript();
  if (!mine) return; // development server
  let shown = false;
  const check = async () => {
    if (shown || document.visibilityState !== "visible") return;
    try {
      const html = await (await fetch("/", { cache: "no-store" })).text();
      const latest = html.match(/\/assets\/index-[^"']+\.js/)?.[0];
      if (!latest || mine.endsWith(latest)) return;
    } catch {
      return;
    }
    shown = true;
    // A warning toast at the bottom, with the reload one tap away; it stays until the page reloads.
    const toast = document.createElement("div");
    toast.className = "new-version";
    toast.setAttribute("role", "alert");
    const text = document.createElement("span");
    text.textContent = `⚠ ${t("The server runs a newer version. Reload so things keep working.")}`;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "primary";
    b.textContent = t("Reload");
    b.onclick = () => location.reload();
    toast.append(text, b);
    document.body.appendChild(toast);
  };
  document.addEventListener("visibilitychange", () => void check());
  setInterval(() => void check(), 60_000);
}
