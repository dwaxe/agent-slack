const INERT_LESS_THAN = "\u2039";
const INERT_AT = "\uFF20";

export function makeStrictUserOutputInert(value: string): string {
  return value
    .replaceAll("<", INERT_LESS_THAN)
    .replace(/@(?=(?:[UWB][A-Z0-9]{6,}|here|channel|everyone)\b)/gi, INERT_AT);
}
