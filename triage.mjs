// Разбор заявки: валидация ввода → вызов модели с таймаутом → проверка ответа модели.
// Модуль не знает про HTTP-сервер: на вход текст и функция-классификатор, на выход статус и тело.

export const TOPICS = Object.freeze(["delivery", "pricing", "other"]);
export const MODEL_TIMEOUT_MS = 300;

export const MANUAL_REVIEW = Object.freeze({ status: "manual_review", topic: null, draft: null });
export const INVALID_INPUT = Object.freeze({ status: "invalid_input" });

// Сырое тело запроса (строка) → текст заявки или null, если ввод некорректный.
export function parseTriageRequest(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const { text } = payload;
  if (typeof text !== "string" || text.trim() === "") return null;
  return text;
}

// Сырой ответ модели (строка) → { topic, draft } или null, если ответ нельзя показывать менеджеру.
// HTTP 200 от провайдера ничего не гарантирует: проверяем JSON, тему из списка и непустой черновик.
export function parseModelOutput(raw) {
  if (typeof raw !== "string") return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object") return null;
  const { topic, draft } = data;
  if (!TOPICS.includes(topic)) return null;
  if (typeof draft !== "string" || draft.trim() === "") return null;
  return { topic, draft: draft.trim() };
}

// Вызов модели с ограничением по времени. По таймауту отменяем запрос через AbortSignal,
// чтобы модель не продолжала работать впустую.
export async function classifyWithTimeout(classify, text, timeoutMs = MODEL_TIMEOUT_MS) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`model timeout after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([classify(text, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Полный сценарий для одного запроса: { httpStatus, body, reason }.
// reason — только для логов сервера, клиенту не отдаётся.
export async function triage(rawBody, { classify, timeoutMs = MODEL_TIMEOUT_MS } = {}) {
  const text = parseTriageRequest(rawBody);
  if (text === null) return { httpStatus: 400, body: INVALID_INPUT, reason: "invalid_input" };

  let raw;
  try {
    raw = await classifyWithTimeout(classify, text, timeoutMs);
  } catch (error) {
    return { httpStatus: 200, body: MANUAL_REVIEW, reason: `model_failed: ${error.message}` };
  }

  const result = parseModelOutput(raw);
  if (result === null) return { httpStatus: 200, body: MANUAL_REVIEW, reason: "model_output_rejected" };

  return { httpStatus: 200, body: { status: "ready", ...result }, reason: "ok" };
}
