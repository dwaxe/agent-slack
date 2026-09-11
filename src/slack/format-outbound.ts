/**
 * Prepare user-authored text for Slack's `chat.postMessage` / `chat.update`.
 *
 * Slack's mrkdwn contract requires:
 *  - literal `&`, `<`, `>` escaped as `&amp;`, `&lt;`, `&gt;`
 *  - user mentions wrapped as `<@U123>`, channel mentions as `<#C123>`,
 *    usergroup mentions as `<!subteam^S123>`, and broadcast mentions as
 *    `<!here>` / `<!channel>` / `<!everyone>`
 *
 * Humans (and LLMs piping text into the CLI) commonly write `@U123` and
 * `[label](https://example.com)` links as well as raw `&`/`<`/`>` — this
 * helper normalizes those to what Slack expects, while leaving
 * already-well-formed Slack tokens intact.
 */
export function formatOutboundSlackText(text: string): string {
  if (!text) {
    return "";
  }

  const codeStash: string[] = [];
  let out = text.replace(/(`+)[\s\S]*?\1/g, (match) => {
    codeStash.push(match);
    return `\uE000${codeStash.length - 1}\uE001`;
  });

  // Slack does not understand CommonMark links in message text. Normalize the
  // common inline form while leaving images, escaped links, and code alone.
  out = out.replace(
    /(?<![!\\])\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)(?:[^()\s]|\([^()\s]*\))+?)\)/gi,
    (...match: unknown[]) => {
      const rawLabel = String(match[1]);
      const rawUrl = String(match[2]);
      const label = rawLabel
        .replace(/\\([\\[\]()])/g, "$1")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const url = rawUrl
        .replace(/\\([\\[\]()])/g, "$1")
        .replace(/\|/g, "%7C")
        .replace(/</g, "%3C")
        .replace(/>/g, "%3E");
      return `<${url}|${label}>`;
    },
  );

  out = out.replace(/\uE000(\d+)\uE001/g, (_match, idx) => codeStash[Number(idx)]!);

  // Protect already-formatted Slack tokens so `<`/`>` inside them aren't escaped.
  const stash: string[] = [];
  out = out.replace(
    /<(?:@[UWB][A-Z0-9]+(?:\|[^>]*)?|#[CG][A-Z0-9]+(?:\|[^>]*)?|!subteam\^[A-Z0-9]+(?:\|[^>]*)?|![a-zA-Z]+(?:\|[^>]*)?|(?:https?:\/\/|mailto:)[^>]+)>/g,
    (m) => {
      stash.push(m);
      return `\u0000${stash.length - 1}\u0000`;
    },
  );

  // Escape literal HTML-ish characters per Slack's mrkdwn rules.
  out = out.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Promote bare user IDs (`@U05BRPTKL6A`) to real mentions.
  out = out.replace(/(^|[^A-Za-z0-9_])@([UWB][A-Z0-9]{6,})\b/g, (_m, pre, id) => `${pre}<@${id}>`);

  // Promote broadcast mentions.
  out = out.replace(
    /(^|[^A-Za-z0-9_])@(here|channel|everyone)\b/g,
    (_m, pre, name) => `${pre}<!${name}>`,
  );

  // Restore protected tokens.
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, idx) => stash[Number(idx)]!);

  return out;
}
