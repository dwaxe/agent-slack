export const SLACK_WORKSPACE_ORIGIN_ERROR =
  "Workspace URL must be a canonical HTTPS Slack or GovSlack origin " +
  "(https://<workspace>.slack.com or https://<workspace>.slack-gov.com).";

type SlackRealm = "commercial" | "gov";

function isSlackOwnedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  const suffix = normalized.endsWith(".slack-gov.com")
    ? ".slack-gov.com"
    : normalized.endsWith(".slack.com")
      ? ".slack.com"
      : null;
  if (!suffix || normalized.length > 253) {
    return false;
  }

  const workspace = normalized.slice(0, -suffix.length);
  return (
    workspace.length > 0 &&
    workspace.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  );
}

export function normalizeSlackWorkspaceUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(SLACK_WORKSPACE_ORIGIN_ERROR);
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== "" ||
    !isSlackOwnedHostname(url.hostname)
  ) {
    throw new Error(SLACK_WORKSPACE_ORIGIN_ERROR);
  }

  return url.origin;
}

export function slackRealmForWorkspaceUrl(workspaceUrl: string): SlackRealm {
  const { hostname } = new URL(normalizeSlackWorkspaceUrl(workspaceUrl));
  return hostname.endsWith(".slack-gov.com") ? "gov" : "commercial";
}

export function slackAppOriginForWorkspace(workspaceUrl: string): string {
  return slackRealmForWorkspaceUrl(workspaceUrl) === "gov"
    ? "https://app.slack-gov.com"
    : "https://app.slack.com";
}

export function slackApiUrlForWorkspace(workspaceUrl: string): string {
  return slackRealmForWorkspaceUrl(workspaceUrl) === "gov"
    ? "https://slack-gov.com/api/"
    : "https://slack.com/api/";
}
