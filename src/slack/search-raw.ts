import type { SlackApiClient } from "./client.ts";
import { asArray, isRecord } from "../lib/object-type-guards.ts";

type StrictMessagePaging = {
  pages: number;
  total: number;
  target: number;
};

// Search totals are estimates and nearby matches may be collapsed. Cursor
// exhaustion, rather than the number of returned rows, proves traversal.
function readStrictMessageCursor(input: {
  messages: Record<string, unknown>;
  pageSize: number;
  responseMetadata: unknown;
}): string | undefined {
  const { messages, pageSize, responseMetadata } = input;
  const { paging } = messages;
  const { pagination } = messages;
  const containers = [paging, pagination, responseMetadata].filter(isRecord);
  const cursors = containers
    .filter((value) => Object.hasOwn(value, "next_cursor"))
    .map((value) => value.next_cursor);
  if (cursors.length === 0) {
    return undefined;
  }
  if (
    !isRecord(paging) ||
    !Number.isInteger(paging.count) ||
    paging.count !== pageSize ||
    !Number.isInteger(paging.total) ||
    Number(paging.total) < 0 ||
    (messages.total !== undefined && messages.total !== paging.total) ||
    (pagination !== undefined &&
      (!isRecord(pagination) ||
        pagination.total_count !== paging.total ||
        pagination.per_page !== pageSize)) ||
    cursors.some(
      (cursor) =>
        typeof cursor !== "string" ||
        cursor.length > 8192 ||
        (cursor !== "" && !/^[\x21-\x7e]+$/.test(cursor)),
    ) ||
    cursors.some((cursor) => cursor !== cursors[0])
  ) {
    throw new Error("Slack search returned malformed or conflicting message cursor metadata");
  }
  return cursors[0] as string;
}

function readStrictMessagePaging(input: {
  messages: Record<string, unknown>;
  expectedPage: number;
  pageSize: number;
  limit: number;
  previous?: StrictMessagePaging;
}): StrictMessagePaging {
  const { paging } = input.messages;
  if (!isRecord(paging)) {
    throw new Error("Slack search omitted message paging metadata; refusing partial output");
  }
  const { count, page: reportedPage, pages, total } = paging;
  if (
    !Number.isInteger(count) ||
    !Number.isInteger(reportedPage) ||
    !Number.isInteger(pages) ||
    !Number.isInteger(total) ||
    Number(count) !== input.pageSize ||
    Number(reportedPage) < 1 ||
    Number(pages) < 0 ||
    Number(total) < 0
  ) {
    throw new Error("Slack search returned malformed message paging metadata");
  }
  if (reportedPage !== input.expectedPage) {
    throw new Error(
      `Slack search returned page ${String(reportedPage)} while page ${input.expectedPage} was requested`,
    );
  }
  const expectedPages = Number(total) === 0 ? 0 : Math.ceil(Number(total) / input.pageSize);
  if (pages !== expectedPages) {
    throw new Error("Slack search returned inconsistent message paging metadata");
  }
  if (
    input.messages.total !== undefined &&
    (!Number.isInteger(input.messages.total) || input.messages.total !== total)
  ) {
    throw new Error("Slack search returned inconsistent message totals");
  }

  const current = {
    pages: Number(pages),
    total: Number(total),
    target: Math.min(Number(total), input.limit),
  };
  if (
    input.previous &&
    (current.pages !== input.previous.pages ||
      current.total !== input.previous.total ||
      current.target !== input.previous.target)
  ) {
    throw new Error("Slack search changed message paging metadata between pages");
  }
  return current;
}

export async function searchMessagesRaw(
  client: SlackApiClient,
  input: { query: string; limit: number; requireCompleteResults?: boolean },
): Promise<Record<string, unknown>[]> {
  const pageSize = Math.min(Math.max(input.limit, 1), 100);
  const out: Record<string, unknown>[] = [];
  let page = 1;
  let pages = 1;
  let strictPaging: StrictMessagePaging | undefined;
  let cursor: string | undefined = input.requireCompleteResults ? "*" : undefined;
  let cursorPaging = false;
  const seenCursors = new Set(["*"]);
  const seenMessages = new Set<string>();

  for (;;) {
    const resp = await client.api("search.messages", {
      query: input.query,
      count: pageSize,
      ...(cursor === undefined ? { page } : { cursor }),
      highlight: false,
      sort: "timestamp",
      sort_dir: "desc",
    });
    const messages = isRecord(resp) ? resp.messages : null;
    if (input.requireCompleteResults && (!isRecord(messages) || !Array.isArray(messages.matches))) {
      throw new Error("Slack search omitted its message matches; refusing partial output");
    }
    const rawMatches = isRecord(messages) ? asArray(messages.matches) : [];
    if (input.requireCompleteResults && rawMatches.some((match) => !isRecord(match))) {
      throw new Error("Slack search returned a malformed message result; refusing partial output");
    }
    const matches = rawMatches.filter(isRecord);
    out.push(...matches);

    if (input.requireCompleteResults && isRecord(messages)) {
      const nextCursor = readStrictMessageCursor({
        messages,
        pageSize,
        responseMetadata: resp.response_metadata,
      });
      if (nextCursor !== undefined || cursorPaging) {
        if (strictPaging !== undefined) {
          throw new Error("Slack search changed message pagination mode before completion");
        }
        if (nextCursor === undefined) {
          throw new Error("Slack search omitted message cursor metadata before completion");
        }
        cursorPaging = true;
        if (matches.length > pageSize) {
          throw new Error(
            "Slack search returned more message matches than the requested page size",
          );
        }
        for (const match of matches) {
          const channel = isRecord(match.channel) ? match.channel.id : undefined;
          const identity =
            typeof channel === "string" && typeof match.ts === "string"
              ? `${channel}:${match.ts}`
              : match.permalink;
          if (typeof identity !== "string" || identity.length === 0 || seenMessages.has(identity)) {
            throw new Error("Slack search returned a duplicate or unidentifiable cursor message");
          }
          seenMessages.add(identity);
        }
        if (nextCursor !== "" && seenCursors.has(nextCursor)) {
          throw new Error("Slack search repeated its message cursor before completion");
        }
        if (out.length >= input.limit || nextCursor === "") {
          return out.slice(0, input.limit);
        }
        if (seenCursors.size >= 100) {
          throw new Error("Slack search exceeded its message cursor page limit before completion");
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
        continue;
      }
      // Older servers may ignore the cursor request and return numbered pages.
      // Keep their existing stricter count and page validation unchanged.
      cursor = undefined;
      strictPaging = readStrictMessagePaging({
        messages,
        expectedPage: page,
        pageSize,
        limit: input.limit,
        previous: strictPaging,
      });
      if (out.length > strictPaging.total) {
        throw new Error("Slack search returned more message matches than its declared total");
      }
      if (out.length >= strictPaging.target) {
        return out.slice(0, strictPaging.target);
      }
      if (matches.length === 0) {
        throw new Error("Slack search returned an empty message page before the declared total");
      }
      if (matches.length < pageSize) {
        throw new Error("Slack search returned a short message page before the declared total");
      }
      if (page >= strictPaging.pages) {
        throw new Error("Slack search exhausted message pages before the declared total");
      }
      page++;
      continue;
    }

    const paging = isRecord(messages) ? (messages.paging ?? messages.pagination) : null;
    const totalPages = Number(isRecord(paging) ? (paging.pages ?? 1) : 1);
    if (Number.isFinite(totalPages) && totalPages > 0) {
      pages = totalPages;
    }

    if (out.length >= input.limit) {
      break;
    }
    if (matches.length === 0) {
      break;
    }
    if (page >= pages) {
      break;
    }
    page++;
  }

  return out.slice(0, input.limit);
}

export async function searchFilesRaw(
  client: SlackApiClient,
  input: { query: string; limit: number },
): Promise<Record<string, unknown>[]> {
  const pageSize = Math.min(Math.max(input.limit, 1), 100);
  const out: Record<string, unknown>[] = [];
  let page = 1;
  let pages = 1;

  for (;;) {
    const resp = await client.api("search.files", {
      query: input.query,
      count: pageSize,
      page,
      highlight: false,
      sort: "timestamp",
      sort_dir: "desc",
    });
    const files = isRecord(resp) ? resp.files : null;
    const matches = isRecord(files) ? asArray(files.matches).filter(isRecord) : [];
    out.push(...matches);

    const paging = isRecord(files) ? (files.paging ?? files.pagination) : null;
    const totalPages = Number(isRecord(paging) ? (paging.pages ?? 1) : 1);
    if (Number.isFinite(totalPages) && totalPages > 0) {
      pages = totalPages;
    }

    if (out.length >= input.limit) {
      break;
    }
    if (matches.length === 0) {
      break;
    }
    if (page >= pages) {
      break;
    }
    page++;
  }

  return out.slice(0, input.limit);
}
