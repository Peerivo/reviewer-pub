import { createAppJwt } from "./crypto.mjs";

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";

export class GitHubError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value));
}

function encodeRepo(repo) {
  const [owner, name, extra] = String(repo).split("/");
  if (!owner || !name || extra) throw new GitHubError("invalid repository identity", 400);
  return `${encodePathSegment(owner)}/${encodePathSegment(name)}`;
}

async function responseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

export class GitHubClient {
  constructor({ appId, privateKey, fetchImpl = fetch }) {
    this.appId = appId;
    this.privateKey = privateKey;
    this.fetchImpl = fetchImpl;
  }

  async request(path, { method = "GET", token, body, accept = "application/vnd.github+json" } = {}) {
    if (!path.startsWith("/")) throw new GitHubError("GitHub API path must be absolute", 500);
    const response = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: {
        accept,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": API_VERSION,
        "user-agent": "Peerivo-Reviewer-GitHub-App/0.2"
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error"
    });
    const payload = await responseBody(response);
    if (!response.ok) {
      const detail = payload && typeof payload === "object" ? payload.message : "request failed";
      throw new GitHubError(`GitHub API ${method} ${path} failed (${response.status}): ${detail}`, response.status);
    }
    return payload;
  }

  appJwt() {
    return createAppJwt({ appId: this.appId, privateKey: this.privateKey });
  }

  async installationToken(installationId) {
    if (!Number.isSafeInteger(installationId) || installationId < 1) throw new GitHubError("invalid installation id", 400);
    const payload = await this.request(`/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      token: this.appJwt(),
      body: {}
    });
    if (!payload || typeof payload.token !== "string" || !payload.token) {
      throw new GitHubError("GitHub did not return an installation token", 502);
    }
    return payload.token;
  }

  async pullRequest(repo, number, token) {
    return this.request(`/repos/${encodeRepo(repo)}/pulls/${number}`, { token });
  }

  async pullFiles(repo, number, token, { maxFiles }) {
    const files = [];
    for (let page = 1; page <= Math.ceil(maxFiles / 100) + 1; page += 1) {
      const batch = await this.request(`/repos/${encodeRepo(repo)}/pulls/${number}/files?per_page=100&page=${page}`, { token });
      if (!Array.isArray(batch)) throw new GitHubError("GitHub pull files response was not an array", 502);
      files.push(...batch);
      if (files.length > maxFiles) throw new GitHubError(`pull request exceeds MAX_FILES (${maxFiles})`, 422);
      if (batch.length < 100) return files;
    }
    throw new GitHubError("pull file pagination exceeded safe bound", 422);
  }

  async tree(repo, sha, token, { maxFiles }) {
    if (!/^[0-9a-f]{40}$/i.test(sha)) throw new GitHubError("invalid tree commit SHA", 400);
    const payload = await this.request(`/repos/${encodeRepo(repo)}/git/trees/${sha}?recursive=1`, { token });
    if (!payload || !Array.isArray(payload.tree)) throw new GitHubError("GitHub tree response is invalid", 502);
    if (payload.truncated) throw new GitHubError("repository tree was truncated; review coverage is incomplete", 422);
    const files = payload.tree.filter(entry => entry?.type === "blob" && typeof entry.path === "string").map(entry => entry.path);
    if (files.length > maxFiles) throw new GitHubError(`repository exceeds MAX_FILES (${maxFiles})`, 422);
    return files;
  }

  async fileContent(repo, path, sha, token, { maxBytes }) {
    const encodedPath = String(path).split("/").map(encodePathSegment).join("/");
    const payload = await this.request(`/repos/${encodeRepo(repo)}/contents/${encodedPath}?ref=${encodePathSegment(sha)}`, { token });
    if (!payload || payload.type !== "file" || payload.encoding !== "base64" || typeof payload.content !== "string") {
      throw new GitHubError(`cannot obtain complete content for ${path}`, 422);
    }
    const bytes = Buffer.from(payload.content.replace(/\n/g, ""), "base64");
    if (bytes.length > maxBytes) throw new GitHubError(`${path} exceeds workflow byte limit`, 422);
    return bytes.toString("utf8");
  }


  async listIssueComments(repo, issueNumber, token, { maxComments = 500 } = {}) {
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new GitHubError("invalid issue number", 400);
    const comments = [];
    for (let page = 1; page <= Math.ceil(maxComments / 100) + 1; page += 1) {
      const batch = await this.request(
        `/repos/${encodeRepo(repo)}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
        { token }
      );
      if (!Array.isArray(batch)) throw new GitHubError("GitHub issue comments response was not an array", 502);
      comments.push(...batch);
      if (comments.length > maxComments) throw new GitHubError("GitHub issue has too many comments", 422);
      if (batch.length < 100) return comments;
    }
    throw new GitHubError("GitHub issue comment pagination exceeded safe bound", 422);
  }

  async createIssueComment(repo, issueNumber, token, body) {
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new GitHubError("invalid issue number", 400);
    return this.request(`/repos/${encodeRepo(repo)}/issues/${issueNumber}/comments`, {
      method: "POST",
      token,
      body: { body: String(body) }
    });
  }

  async updateIssueComment(repo, commentId, token, body) {
    const id = Number(commentId);
    if (!Number.isSafeInteger(id) || id < 1) throw new GitHubError("invalid comment id", 400);
    return this.request(`/repos/${encodeRepo(repo)}/issues/comments/${id}`, {
      method: "PATCH",
      token,
      body: { body: String(body) }
    });
  }

  async createCheck(repo, token, body) {
    return this.request(`/repos/${encodeRepo(repo)}/check-runs`, { method: "POST", token, body });
  }

  async updateCheck(repo, checkRunId, token, body) {
    return this.request(`/repos/${encodeRepo(repo)}/check-runs/${checkRunId}`, { method: "PATCH", token, body });
  }
}
