import { isTrackedUpstreamPluginInSync } from "./lib/upstream-plugin-identity.mjs";
import { planUpstreamPluginIssueAction } from "./lib/upstream-plugin-issues.mjs";
import { readUpstreamPluginLock } from "./lib/upstream-plugin-lock.mjs";
import { fetchLatestPublishedPluginVersion } from "./lib/upstream-plugin-registry.mjs";
import { UPSTREAM_PLUGIN_SPECS } from "./lib/upstream-plugin-specs.mjs";

const GITHUB_API_ORIGIN = "https://api.github.com";
const WRITE_ISSUES = process.argv.includes("--write-issues");

function getTrackedEntry(lock, pluginId) {
  const tracked = lock.plugins?.[pluginId];
  if (!tracked) {
    throw new Error(
      `Missing tracked upstream entry for ${pluginId} in references/upstream-plugins/lock.json. Run pnpm run upstream:sync to rebuild it.`,
    );
  }
  return tracked;
}

function createGitHubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "opencode-quota-upstream-plugin-check",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubRequest(path, token, init = {}) {
  const response = await fetch(`${GITHUB_API_ORIGIN}${path}`, {
    ...init,
    headers: {
      ...createGitHubHeaders(token),
      ...init.headers,
    },
  });

  const rawBody = await response.text();
  const data = rawBody ? JSON.parse(rawBody) : null;

  if (!response.ok) {
    const detail =
      data && typeof data === "object" && "message" in data && typeof data.message === "string"
        ? data.message
        : response.statusText;
    throw new Error(`GitHub API ${response.status} ${detail} for ${path}`);
  }

  return data;
}

async function listOpenIssues(repository, token) {
  const issues = [];

  for (let page = 1; ; page += 1) {
    const data = await githubRequest(
      `/repos/${repository}/issues?state=open&per_page=100&page=${page}`,
      token,
    );

    if (!Array.isArray(data) || data.length === 0) break;

    issues.push(...data.filter((issue) => !issue.pull_request));

    if (data.length < 100) break;
  }

  return issues;
}

async function createIssue(repository, token, title, body) {
  await githubRequest(`/repos/${repository}/issues`, token, {
    body: JSON.stringify({ body, title }),
    method: "POST",
  });
}

async function updateIssueBody(repository, token, issueNumber, body) {
  await githubRequest(`/repos/${repository}/issues/${issueNumber}`, token, {
    body: JSON.stringify({ body }),
    method: "PATCH",
  });
}

async function addIssueComment(repository, token, issueNumber, body) {
  await githubRequest(`/repos/${repository}/issues/${issueNumber}/comments`, token, {
    body: JSON.stringify({ body }),
    method: "POST",
  });
}

async function closeIssue(repository, token, issueNumber) {
  await githubRequest(`/repos/${repository}/issues/${issueNumber}`, token, {
    body: JSON.stringify({ state: "closed" }),
    method: "PATCH",
  });
}

async function reconcileIssues(repository, token, plannedActions) {
  for (const action of plannedActions) {
    if (action.create) {
      console.log(`Creating ${action.create.title}`);
      await createIssue(repository, token, action.create.title, action.create.body);
    }

    if (action.update) {
      console.log(`Updating #${action.update.issueNumber} for ${action.title}`);
      await updateIssueBody(repository, token, action.update.issueNumber, action.update.body);
    }

    for (const comment of action.comments) {
      console.log(`Commenting on #${comment.issueNumber} for ${action.title}`);
      await addIssueComment(repository, token, comment.issueNumber, comment.body);
    }

    for (const closeAction of action.close) {
      console.log(`Closing #${closeAction.issueNumber} for ${action.title}`);
      await addIssueComment(repository, token, closeAction.issueNumber, closeAction.commentBody);
      await closeIssue(repository, token, closeAction.issueNumber);
    }
  }
}

async function main() {
  const lock = await readUpstreamPluginLock();
  const latestVersions = [];

  for (const spec of UPSTREAM_PLUGIN_SPECS) {
    latestVersions.push(await fetchLatestPublishedPluginVersion(spec));
  }

  const latestByPluginId = new Map(latestVersions.map((entry) => [entry.pluginId, entry]));

  for (const spec of UPSTREAM_PLUGIN_SPECS) {
    const tracked = getTrackedEntry(lock, spec.pluginId);
    const latest = latestByPluginId.get(spec.pluginId);
    const status = isTrackedUpstreamPluginInSync(tracked, latest)
      ? "up-to-date"
      : "update available";
    console.log(
      `${spec.pluginId}: tracked ${tracked.version}, latest ${latest.version} (${status})`,
    );
  }

  if (!WRITE_ISSUES) return;

  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const token = process.env.GITHUB_TOKEN ?? "";

  if (!repository) {
    throw new Error("GITHUB_REPOSITORY is required when --write-issues is set.");
  }
  if (!token) {
    throw new Error("GITHUB_TOKEN is required when --write-issues is set.");
  }

  const existingIssues = await listOpenIssues(repository, token);
  const plannedActions = UPSTREAM_PLUGIN_SPECS.map((spec) =>
    planUpstreamPluginIssueAction({
      existingIssues,
      latest: latestByPluginId.get(spec.pluginId),
      spec,
      tracked: getTrackedEntry(lock, spec.pluginId),
    }),
  );

  await reconcileIssues(repository, token, plannedActions);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
