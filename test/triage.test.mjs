import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTriageServer } from "../server.mjs";
import { triage, parseModelOutput } from "../triage.mjs";

// Интеграционные тесты: настоящий HTTP-сервер с выданным имитатором модели.
let server;
let baseUrl;

before(async () => {
  server = createTriageServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function post(body) {
  const response = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const MANUAL = { status: "manual_review", topic: null, draft: null };

test("корректная заявка → ready с темой и черновиком", async () => {
  assert.deepEqual(await post({ text: "Когда будет доставка?" }), {
    status: 200,
    body: { status: "ready", topic: "delivery", draft: "Спасибо за обращение. Уточним детали заявки." },
  });
  const pricing = await post({ text: "Какая стоимость?" });
  assert.equal(pricing.body.topic, "pricing");
});

for (const [name, body] of [
  ["пустая строка", { text: "" }],
  ["только пробелы", { text: "   \n " }],
  ["нет поля text", {}],
  ["text не строка", { text: 42 }],
  ["тело — массив", "[]"],
  ["тело — null", "null"],
  ["битый JSON", "{not json"],
]) {
  test(`некорректный ввод (${name}) → 400 invalid_input`, async () => {
    assert.deepEqual(await post(body), { status: 400, body: { status: "invalid_input" } });
  });
}

for (const marker of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`сбой модели ${marker} → 200 manual_review`, async () => {
    const started = Date.now();
    assert.deepEqual(await post({ text: `Заявка про доставку ${marker}` }), { status: 200, body: MANUAL });
    // Таймаут модели — 300 мс; имитатор в режиме [timeout] думает 1200 мс. Не ждём его.
    assert.ok(Date.now() - started < 1000, "ответ не должен ждать модель дольше таймаута");
  });
}

test("по таймауту запрос к модели отменяется через AbortSignal", async () => {
  let signal;
  const slowModel = (_text, options) => {
    signal = options.signal;
    return new Promise(() => {});
  };
  const result = await triage(JSON.stringify({ text: "заявка" }), { classify: slowModel, timeoutMs: 20 });
  assert.deepEqual(result.body, MANUAL);
  assert.equal(signal.aborted, true);
});

test("parseModelOutput отбрасывает невалидные ответы модели", () => {
  assert.equal(parseModelOutput('{"topic":"delivery","draft":""}'), null);
  assert.equal(parseModelOutput('{"topic":"delivery"}'), null);
  assert.equal(parseModelOutput('{"topic":"refund","draft":"ok"}'), null);
  assert.equal(parseModelOutput("null"), null);
  assert.deepEqual(parseModelOutput('{"topic":"other","draft":" Ответ "}'), { topic: "other", draft: "Ответ" });
});
