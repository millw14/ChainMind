export function redactRpcUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    if (u.searchParams.has("api-key")) u.searchParams.set("api-key", "***");
    return u.toString();
  } catch {
    return url.slice(0, 48) + (url.length > 48 ? "…" : "");
  }
}
