/**
 * Light / dark theme, server-safe half: the storage key, browser chrome colours and the inline script that stamps
 * <html data-theme> before first paint (inlined in app/layout.tsx). It follows the OS setting while the preference is
 * "system". The client half (hooks, setter) is ./theme.ts.
 */
export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";

export const THEME_KEY = "cosign.theme";
/** Browser chrome colour per theme (matches --bg). */
export const THEME_COLOR: Record<Theme, string> = { light: "#f4f5f7", dark: "#0b0c0f" };

/**
 * Runs synchronously in <head>: no flash of the wrong theme, and OS changes are followed while on "system".
 * `?theme=light|dark|system` on any URL sets (and remembers) the preference: handy for the projector laptop.
 */
export const THEME_SCRIPT = `(function(){try{var d=document.documentElement,m=window.matchMedia("(prefers-color-scheme: dark)");try{var q=new URLSearchParams(location.search).get("theme");if(q==="light"||q==="dark")localStorage.setItem("${THEME_KEY}",q);else if(q==="system")localStorage.removeItem("${THEME_KEY}")}catch(e){}function pref(){var p=null;try{p=localStorage.getItem("${THEME_KEY}")}catch(e){}return p==="light"||p==="dark"?p:"system"}function apply(){var p=pref(),t=p==="system"?(m.matches?"dark":"light"):p;d.setAttribute("data-theme",t);d.setAttribute("data-theme-pref",p);d.style.colorScheme=t;var c=t==="dark"?"${THEME_COLOR.dark}":"${THEME_COLOR.light}";var ms=document.querySelectorAll('meta[name="theme-color"]');for(var i=0;i<ms.length;i++)ms[i].setAttribute("content",c)}apply();window.__cosignApplyTheme=apply;if(m.addEventListener)m.addEventListener("change",apply);else if(m.addListener)m.addListener(apply)}catch(e){}})()`;
