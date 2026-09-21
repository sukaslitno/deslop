const KNOWN_APPLICATIONS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["Figma", ["figma", "com.figma.desktop.shipit"]],
  ["Slack", ["slack", "com.tinyspeck.slackmacgap"]],
  ["Arc", ["arc", "company.thebrowser.browser"]],
  ["Claude", ["claude"]],
  ["Codex", ["codex"]],
  ["ChatGPT", ["chatgpt", "com.openai.chat"]],
  ["Lark", ["lark", "larkinternational"]],
];

/**
 * Group an app-cache candidate only by known application path components below
 * the user's Library, never by an arbitrary account name or parent directory.
 */
export function appCacheName(path: string, fallback: string) {
  const components = path
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((component) => component.toLowerCase());
  const library = components.lastIndexOf("library");
  const platformRoot = library >= 0 ? library : components.lastIndexOf("appdata");
  const appComponents = platformRoot >= 0 ? components.slice(platformRoot + 1) : [];
  for (const [name, identifiers] of KNOWN_APPLICATIONS) {
    if (appComponents.some((component) => identifiers.includes(component))) return name;
  }
  return fallback;
}
