import { describe, expect, test } from "bun:test";
import type { SlackApiClient } from "../src/slack/client.ts";
import { searchMessagesRaw } from "../src/slack/search-raw.ts";
import { searchSlack } from "../src/slack/search.ts";

const auth = { auth_type: "standard" as const, token: "test-token" };
const workspaceUrl = "https://workspace.slack.com";

function rawMatches(count: number, offset = 0): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    ts: `${offset + index + 1}.000001`,
    channel: { id: "C12345678" },
    permalink: `${workspaceUrl}/archives/C12345678/p${offset + index + 1}000001`,
  }));
}

function cursorPage(count: number, total: number, nextCursor: unknown, offset = 0) {
  return {
    messages: {
      matches: rawMatches(count, offset),
      total,
      paging: {
        count: 100,
        page: 1,
        pages: Math.ceil(total / 100),
        total,
        next_cursor: nextCursor,
      },
      pagination: { per_page: 100, total_count: total, next_cursor: nextCursor },
    },
  };
}

describe("complete cursor-paginated Slack search", () => {
  test("traverses the short DM-search pages despite drifting estimated totals", async () => {
    const responses = [cursorPage(99, 116, "dm-page-2"), cursorPage(17, 117, "", 99)];
    const requests: Record<string, unknown>[] = [];
    const client = {
      api: async (method: string, params: Record<string, unknown>) => {
        expect(method).toBe("search.messages");
        requests.push(params);
        const response = responses.shift();
        if (!response) {
          throw new Error("Unexpected extra search request");
        }
        return response;
      },
    } as unknown as SlackApiClient;

    const result = await searchSlack({
      client,
      auth,
      options: {
        workspace_url: workspaceUrl,
        query: "is:dm",
        kind: "messages",
        limit: 200,
        metadata_only: true,
        require_complete_results: true,
      },
    });

    expect(result.metadata_only).toBe(true);
    expect(result.messages).toHaveLength(116);
    expect(new Set(result.messages?.map((message) => message.permalink)).size).toBe(116);
    expect(requests.map((request) => request.cursor)).toEqual(["*", "dm-page-2"]);
    expect(
      requests.every((request) => request.count === 100 && !Object.hasOwn(request, "page")),
    ).toBe(true);
  });

  test("follows nonterminal cursors through short and empty search pages", async () => {
    for (const counts of [
      [0, 1, 2],
      [1, 0, 2],
    ]) {
      let offset = 0;
      const responses = counts.map((count, index) => {
        const response = cursorPage(
          count,
          5,
          index === counts.length - 1 ? "" : `next-${index + 1}`,
          offset,
        );
        offset += count;
        return response;
      });
      const requests: Record<string, unknown>[] = [];
      const client = {
        api: async (_method: string, params: Record<string, unknown>) => {
          requests.push(params);
          const response = responses.shift();
          if (!response) {
            throw new Error("Unexpected extra search request");
          }
          return response;
        },
      } as unknown as SlackApiClient;
      expect(
        await searchMessagesRaw(client, {
          query: "is:dm",
          limit: 200,
          requireCompleteResults: true,
        }),
      ).toHaveLength(3);
      expect(requests.map((request) => request.cursor)).toEqual(["*", "next-1", "next-2"]);
    }
  });

  test("an explicit terminal cursor succeeds below the estimated total", async () => {
    const client = { api: async () => cursorPage(3, 99, "") } as unknown as SlackApiClient;
    expect(
      await searchMessagesRaw(client, {
        query: "is:dm",
        limit: 200,
        requireCompleteResults: true,
      }),
    ).toHaveLength(3);
  });

  test("traverses a cursor supplied only in root response metadata", async () => {
    const responses = [cursorPage(1, 5, "root-next"), cursorPage(1, 5, "", 1)].map((response) => {
      const { next_cursor, ...paging } = response.messages.paging;
      const { next_cursor: _paginationCursor, ...pagination } = response.messages.pagination;
      return {
        messages: { ...response.messages, paging, pagination },
        response_metadata: { next_cursor },
      };
    });
    const requests: Record<string, unknown>[] = [];
    const client = {
      api: async (_method: string, params: Record<string, unknown>) => {
        requests.push(params);
        return responses.shift();
      },
    } as unknown as SlackApiClient;
    expect(
      await searchMessagesRaw(client, {
        query: "is:dm",
        limit: 200,
        requireCompleteResults: true,
      }),
    ).toHaveLength(2);
    expect(requests.map((request) => request.cursor)).toEqual(["*", "root-next"]);
  });

  test("rejects switching from numbered pages to cursors mid-search", async () => {
    const responses = [
      {
        messages: {
          matches: rawMatches(100),
          paging: { count: 100, page: 1, pages: 2, total: 101 },
        },
      },
      cursorPage(1, 101, "", 100),
    ];
    const requests: Record<string, unknown>[] = [];
    const client = {
      api: async (_method: string, params: Record<string, unknown>) => {
        requests.push(params);
        return responses.shift();
      },
    } as unknown as SlackApiClient;
    await expect(
      searchMessagesRaw(client, {
        query: "is:dm",
        limit: 200,
        requireCompleteResults: true,
      }),
    ).rejects.toThrow("changed message pagination mode before completion");
    expect(requests[1]?.page).toBe(2);
    expect(requests[1]?.cursor).toBeUndefined();
  });

  test("does not stop at the estimated total while a continuation cursor exists", async () => {
    const responses = [cursorPage(1, 1, "more-results"), cursorPage(1, 2, "", 1)];
    let requests = 0;
    const client = {
      api: async () => {
        requests++;
        const response = responses.shift();
        if (!response) {
          throw new Error("Unexpected extra search request");
        }
        return response;
      },
    } as unknown as SlackApiClient;
    expect(
      await searchMessagesRaw(client, {
        query: "is:dm",
        limit: 200,
        requireCompleteResults: true,
      }),
    ).toHaveLength(2);
    expect(requests).toBe(2);
  });

  test("rejects a missing cursor after cursor pagination has begun", async () => {
    const missing = cursorPage(0, 1, "");
    const { next_cursor: _pagingCursor, ...paging } = missing.messages.paging;
    const { next_cursor: _paginationCursor, ...pagination } = missing.messages.pagination;
    const responses = [
      cursorPage(0, 1, "continue"),
      { messages: { ...missing.messages, paging, pagination } },
    ];
    const client = { api: async () => responses.shift() } as unknown as SlackApiClient;
    await expect(
      searchMessagesRaw(client, {
        query: "is:dm",
        limit: 200,
        requireCompleteResults: true,
      }),
    ).rejects.toThrow("omitted message cursor metadata before completion");
  });

  test("rejects malformed and conflicting cursor evidence without partial output", async () => {
    const conflicting = cursorPage(1, 1, "paging-cursor");
    conflicting.messages.pagination.next_cursor = "different-cursor";
    const malformedPaging = cursorPage(1, 1, "");
    malformedPaging.messages.pagination.total_count = 2;
    const conflictingRoot = {
      ...cursorPage(1, 1, "body-cursor"),
      response_metadata: { next_cursor: "root-cursor" },
    };
    const invalidResponses = [
      ...[null, false, 1, {}, " leading-space", "line\nbreak", "x".repeat(8193)].map((cursor) =>
        cursorPage(1, 1, cursor),
      ),
      conflicting,
      malformedPaging,
      conflictingRoot,
    ];
    for (const response of invalidResponses) {
      const client = { api: async () => response } as unknown as SlackApiClient;
      await expect(
        searchMessagesRaw(client, {
          query: "is:dm",
          limit: 200,
          requireCompleteResults: true,
        }),
      ).rejects.toThrow("malformed or conflicting message cursor metadata");
    }
  });

  test("rejects repeated cursors rather than looping or returning partial results", async () => {
    for (const cursors of [["*"], ["repeated", "repeated"]]) {
      let index = 0;
      const client = {
        api: async () => cursorPage(0, 1, cursors[index++]),
      } as unknown as SlackApiClient;
      await expect(
        searchMessagesRaw(client, {
          query: "is:dm",
          limit: 200,
          requireCompleteResults: true,
        }),
      ).rejects.toThrow("repeated its message cursor");
      expect(index).toBe(cursors.length);
    }
  });

  test("rejects an exact message identity repeated across cursor pages", async () => {
    const responses = [cursorPage(1, 2, "next-page"), cursorPage(1, 2, "")];
    const client = { api: async () => responses.shift() } as unknown as SlackApiClient;
    await expect(
      searchMessagesRaw(client, {
        query: "is:dm",
        limit: 200,
        requireCompleteResults: true,
      }),
    ).rejects.toThrow("duplicate or unidentifiable cursor message");
  });

  test("caps empty but advancing cursor pagination at 100 requests", async () => {
    const requests: Record<string, unknown>[] = [];
    const client = {
      api: async (_method: string, params: Record<string, unknown>) => {
        requests.push(params);
        if (requests.length > 100) {
          throw new Error("Exceeded the request bound");
        }
        return cursorPage(0, 10000, `cursor-${requests.length}`);
      },
    } as unknown as SlackApiClient;
    await expect(
      searchMessagesRaw(client, {
        query: "is:dm",
        limit: 200,
        requireCompleteResults: true,
      }),
    ).rejects.toThrow("exceeded its message cursor page limit");
    expect(requests).toHaveLength(100);
    expect(requests[99]?.cursor).toBe("cursor-99");
    expect(requests.every((request) => !Object.hasOwn(request, "page"))).toBe(true);
  });
});
