import assert from "node:assert/strict";
import test from "node:test";

const output = process.env.DESLOP_I18N_TEST_OUTPUT;
if (!output) throw new Error("DESLOP_I18N_TEST_OUTPUT is required");
const { en } = await import(`${output}/en.js`);
const { ru } = await import(`${output}/ru.js`);

test("English and Russian catalogs have identical message keys", () => {
  assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort());
  assert.ok(Object.values(ru).every((message) => typeof message === "string" && message.length > 0));
});

test("workspace navigation and Phase D route labels are localized", () => {
  assert.deepEqual(
    [en.clean, en.diskMap, en.automations, en.assistant],
    ["Clean", "Disk Map", "Automations", "Assistant"],
  );
  assert.deepEqual(
    [ru.clean, ru.diskMap, ru.automations, ru.assistant],
    ["Очистка", "Карта диска", "Автоматизации", "Помощник"],
  );
  assert.equal(en.readOnlyPreview, "Read-only preview");
  assert.equal(ru.readOnlyPreview, "Предпросмотр только для чтения");
  assert.equal(en.connectAgent, "Connect an agent");
  assert.equal(ru.connectAgent, "Подключите агента");
  assert.match(en.selectedFolderOnly, /manifest/i);
  assert.match(ru.selectedFolderOnly, /манифест/i);
});
