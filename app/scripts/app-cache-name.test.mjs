import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const output = process.env.DESLOP_APP_CACHE_TEST_OUTPUT;
if (!output) throw new Error("DESLOP_APP_CACHE_TEST_OUTPUT is required");
const { appCacheName } = await import(pathToFileURL(resolve(output, "app-cache-name.js")).href);

test("application names come from known Library cache components, never account names", () => {
  assert.equal(appCacheName("/Users/marcus/Library/Caches/com.openai.chat", "Other application"), "ChatGPT");
  assert.equal(appCacheName("/Users/marcus/Library/Caches/com.figma.Desktop.ShipIt", "Other application"), "Figma");
  assert.equal(appCacheName("C:\\Users\\marcus\\AppData\\Roaming\\Slack\\Cache", "Other application"), "Slack");
  assert.equal(appCacheName("/Users/clark/Library/Caches/unlisted-app", "Other application"), "Other application");
  assert.equal(appCacheName("C:\\Users\\lark\\Library\\Caches\\unlisted-app", "Другое приложение"), "Другое приложение");
});
