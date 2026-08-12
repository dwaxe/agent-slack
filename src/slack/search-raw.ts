import type { SlackApiClient } from "./client.ts";
import { asArray, isRecord } from "../lib/object-type-guards.ts";

type StrictMessagePaging = {
  pages: number;
  total: number;
  target: number;
};

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

  for (;;) {
    const resp = await client.api("search.messages", {
      query: input.query,
      count: pageSize,
      page,
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
