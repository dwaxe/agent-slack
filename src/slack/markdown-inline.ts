type ParsedCodeSpan = {
  content: string;
  end: number;
};

type ParsedMarkdownLink = {
  label: string;
  url: string;
  end: number;
};

export function parseCodeSpanAt(text: string, start: number): ParsedCodeSpan | null {
  if (text[start] !== "`" || isEscaped(text, start)) {
    return null;
  }

  const openerLength = countBacktickRun(text, start);
  const contentStart = start + openerLength;
  let cursor = contentStart;

  while (cursor < text.length) {
    if (text[cursor] !== "`") {
      cursor++;
      continue;
    }

    const closerLength = countBacktickRun(text, cursor);
    if (closerLength === openerLength) {
      return {
        content: text.slice(contentStart, cursor),
        end: cursor + closerLength,
      };
    }
    cursor += closerLength;
  }

  return null;
}

export function parseMarkdownLinkAt(text: string, start: number): ParsedMarkdownLink | null {
  if (
    text[start] !== "[" ||
    isEscaped(text, start) ||
    (text[start - 1] === "!" && !isEscaped(text, start - 1))
  ) {
    return null;
  }

  const labelEnd = findBalancedEnd({
    text,
    start: start + 1,
    open: "[",
    close: "]",
    rejectWhitespace: false,
  });
  if (labelEnd == null || text[labelEnd + 1] !== "(") {
    return null;
  }

  const destinationStart = labelEnd + 2;
  const destination = parseLinkDestination(text, destinationStart);
  if (!destination) {
    return null;
  }

  const rawUrl = unescapeMarkdownPunctuation(destination.value);
  const scheme = /^(https?|mailto):/i.exec(rawUrl);
  if (!scheme) {
    return null;
  }

  return {
    label: unescapeMarkdownPunctuation(text.slice(start + 1, labelEnd)),
    url: `${scheme[1]!.toLowerCase()}:${rawUrl.slice(scheme[0].length)}`,
    end: destination.end,
  };
}

export function markdownLinksToSlackMrkdwn(text: string): string {
  let output = "";
  let cursor = 0;

  while (cursor < text.length) {
    const codeSpan = parseCodeSpanAt(text, cursor);
    if (codeSpan) {
      output += text.slice(cursor, codeSpan.end);
      cursor = codeSpan.end;
      continue;
    }

    const link = parseMarkdownLinkAt(text, cursor);
    if (link) {
      const label = link.label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const url = link.url.replace(/\|/g, "%7C").replace(/</g, "%3C").replace(/>/g, "%3E");
      output += `<${url}|${label}>`;
      cursor = link.end;
      continue;
    }

    output += text[cursor];
    cursor++;
  }

  return output;
}

function parseLinkDestination(text: string, start: number): { value: string; end: number } | null {
  if (text[start] === "<") {
    let cursor = start + 1;
    while (cursor < text.length) {
      const char = text[cursor]!;
      if (char === "\\" && cursor + 1 < text.length) {
        cursor += 2;
        continue;
      }
      if (char === ">") {
        if (text[cursor + 1] !== ")") {
          return null;
        }
        return { value: text.slice(start + 1, cursor), end: cursor + 2 };
      }
      if (char === "<" || /\s/.test(char)) {
        return null;
      }
      cursor++;
    }
    return null;
  }

  const end = findBalancedEnd({
    text,
    start,
    open: "(",
    close: ")",
    rejectWhitespace: true,
  });
  if (end == null || end === start) {
    return null;
  }
  return { value: text.slice(start, end), end: end + 1 };
}

function findBalancedEnd(input: {
  text: string;
  start: number;
  open: string;
  close: string;
  rejectWhitespace: boolean;
}): number | null {
  const { text, start, open, close, rejectWhitespace } = input;
  let depth = 1;
  let cursor = start;

  while (cursor < text.length) {
    const char = text[cursor]!;
    if (char === "\\" && cursor + 1 < text.length) {
      cursor += 2;
      continue;
    }
    if (char === "\n" || (rejectWhitespace && /\s/.test(char))) {
      return null;
    }
    if (char === open) {
      depth++;
    } else if (char === close) {
      depth--;
      if (depth === 0) {
        return cursor;
      }
    }
    cursor++;
  }

  return null;
}

function countBacktickRun(text: string, start: number): number {
  let cursor = start;
  while (text[cursor] === "`") {
    cursor++;
  }
  return cursor - start;
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}

function unescapeMarkdownPunctuation(value: string): string {
  let output = "";
  let cursor = 0;

  while (cursor < value.length) {
    const next = value[cursor + 1];
    if (value[cursor] === "\\" && next && isAsciiPunctuation(next)) {
      output += next;
      cursor += 2;
      continue;
    }
    output += value[cursor];
    cursor++;
  }

  return output;
}

function isAsciiPunctuation(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e)
  );
}
