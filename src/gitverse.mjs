const ACCEPT = "application/vnd.gitverse.object+json;version=latest";

export class GitVerseError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = "GitVerseError";
    this.status = status;
  }
}

function repoParts(fullName) {
  const value = String(fullName || "");
  if (!/^[^/\s]+\/[^/\s]+$/.test(value)) throw new GitVerseError("invalid GitVerse repository identity", 400);
  const [owner, repo] = value.split("/");
  return [encodeURIComponent(owner), encodeURIComponent(repo)];
}

function fullSha(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) throw new GitVerseError(`${label} is not a full commit SHA`, 400);
  return value.toLowerCase();
}

async function parseResponse(response, label) {
  if (response.status === 204) return null;
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; }
  catch { throw new GitVerseError(`${label} returned non-JSON`, 502); }
  if (!response.ok) {
    const detail = body?.error?.message || body?.message || "request failed";
    throw new GitVerseError(`${label} failed (${response.status}): ${detail}`, response.status);
  }
  return body;
}

function asArray(body, label) {
  if (Array.isArray(body) && body.length === 1 && Array.isArray(body[0])) return body[0];
  if (!Array.isArray(body)) throw new GitVerseError(`${label} returned a non-array`, 502);
  return body;
}

export class GitVerseClient {
  constructor({ apiBaseUrl = "https://api.gitverse.ru", token, fetchImpl = fetch }) {
    this.apiBaseUrl = String(apiBaseUrl).replace(/\/$/, "");
    this.token = String(token);
    this.fetchImpl = fetchImpl;
  }

  async request(path, { method = "GET", body = null } = {}) {
    if (!path.startsWith("/")) throw new GitVerseError("GitVerse API path must be absolute", 500);
    const headers = {
      accept: ACCEPT,
      authorization: `Bearer ${this.token}`,
      "user-agent": "Peerivo-Reviewer-GitVerse/0.5"
    };
    let payload;
    if (body !== null) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await this.fetchImpl(this.apiBaseUrl + path, {
      method,
      headers,
      body: payload,
      redirect: "error"
    });
    return parseResponse(response, `GitVerse API ${method} ${path.split("?")[0]}`);
  }

  async currentUser() {
    const user = await this.request("/user");
    if (!Number.isSafeInteger(user?.id) || user.id < 1 || typeof user?.login !== "string" || !user.login) {
      throw new GitVerseError("GitVerse returned invalid authenticated user identity", 502);
    }
    return user;
  }

  async manageableRepositories({ maxRepositories = 1000 } = {}) {
    const limit = Number(maxRepositories);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new GitVerseError("invalid repository discovery limit", 500);
    const result = [];
    const pages = Math.ceil(limit / 50) + 1;
    for (let page = 1; page <= pages; page += 1) {
      const batch = asArray(await this.request(`/user/repos?page=${page}&per_page=50`), "GitVerse repositories");
      result.push(...batch);
      if (result.length > limit) throw new GitVerseError(`GitVerse account exceeds repository discovery limit (${limit})`, 422);
      if (batch.length < 50) return result;
    }
    throw new GitVerseError("GitVerse repository pagination exceeded safe bound", 422);
  }

  async repository(fullName) {
    const [owner, repo] = repoParts(fullName);
    return this.request(`/repos/${owner}/${repo}`);
  }

  async pullRequest(fullName, pullNumber) {
    if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) throw new GitVerseError("invalid GitVerse pull request number", 400);
    const [owner, repo] = repoParts(fullName);
    return this.request(`/repos/${owner}/${repo}/pulls/${pullNumber}`);
  }

  async pullFiles(fullName, pullNumber, { maxFiles }) {
    const [owner, repo] = repoParts(fullName);
    const result = [];
    const pages = Math.ceil(maxFiles / 50) + 1;
    for (let page = 1; page <= pages; page += 1) {
      const batch = asArray(
        await this.request(`/repos/${owner}/${repo}/pulls/${pullNumber}/files?page=${page}&per_page=50`),
        "GitVerse pull files"
      );
      result.push(...batch);
      if (result.length > maxFiles) throw new GitVerseError(`pull request exceeds MAX_FILES (${maxFiles})`, 422);
      if (batch.length < 50) return result;
    }
    throw new GitVerseError("GitVerse pull file pagination exceeded safe bound", 422);
  }

  async commit(fullName, sha) {
    const [owner, repo] = repoParts(fullName);
    return this.request(`/repos/${owner}/${repo}/commits/${encodeURIComponent(fullSha(sha, "commit SHA"))}`);
  }

  async tree(fullName, treeSha, { maxFiles }) {
    const [owner, repo] = repoParts(fullName);
    const sha = fullSha(treeSha, "tree SHA");
    const result = [];
    for (let page = 1; page <= 2000; page += 1) {
      const body = await this.request(
        `/repos/${owner}/${repo}/git/trees/${sha}?recursive=true&page=${page}&per_page=100`
      );
      if (!body || !Array.isArray(body.tree)) throw new GitVerseError("GitVerse tree response is invalid", 502);
      if (body.truncated === true) throw new GitVerseError("GitVerse tree response is truncated", 422);
      for (const item of body.tree) {
        if (item?.type === "blob" && typeof item.path === "string") result.push(item.path);
      }
      if (result.length > maxFiles) throw new GitVerseError(`repository exceeds MAX_FILES (${maxFiles})`, 422);
      const total = Number(body.total_count);
      if ((Number.isSafeInteger(total) && total >= 0 && result.length >= total) || body.tree.length < 100) return result;
    }
    throw new GitVerseError("GitVerse tree pagination exceeded safe bound", 422);
  }

  async fileContent(fullName, path, ref, { maxBytes }) {
    const [owner, repo] = repoParts(fullName);
    const encodedPath = String(path).split("/").map(encodeURIComponent).join("/");
    const body = await this.request(`/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(fullSha(ref, "file ref"))}`);
    if (!body || body.type !== "file" || body.encoding !== "base64" || typeof body.content !== "string") {
      throw new GitVerseError(`GitVerse content response is invalid for ${path}`, 502);
    }
    const bytes = Buffer.from(body.content.replace(/\s+/g, ""), "base64");
    if (bytes.length > maxBytes) throw new GitVerseError(`${path} exceeds byte limit`, 422);
    return bytes.toString("utf8");
  }

  async listWebhooks(fullName, { maxHooks = 500 } = {}) {
    const [owner, repo] = repoParts(fullName);
    const result = [];
    const pages = Math.ceil(maxHooks / 50) + 1;
    for (let page = 1; page <= pages; page += 1) {
      const batch = asArray(await this.request(`/repos/${owner}/${repo}/hooks?page=${page}&per_page=50`), "GitVerse webhooks");
      result.push(...batch);
      if (result.length > maxHooks) throw new GitVerseError("GitVerse repository has too many webhooks", 422);
      if (batch.length < 50) return result;
    }
    throw new GitVerseError("GitVerse webhook pagination exceeded safe bound", 422);
  }

  async createWebhook(fullName, { url, authorizationHeader }) {
    const [owner, repo] = repoParts(fullName);
    return this.request(`/repos/${owner}/${repo}/hooks`, {
      method: "POST",
      body: {
        active: true,
        events: ["pull_request"],
        config: {
          url,
          content_type: "json",
          http_method: "POST",
          authorization_header: authorizationHeader
        }
      }
    });
  }

  async updateWebhook(fullName, hookId, { url, authorizationHeader }) {
    const id = Number(hookId);
    if (!Number.isSafeInteger(id) || id < 1) throw new GitVerseError("invalid GitVerse webhook id", 400);
    const [owner, repo] = repoParts(fullName);
    return this.request(`/repos/${owner}/${repo}/hooks/${id}`, {
      method: "PATCH",
      body: {
        active: true,
        events: ["pull_request"],
        config: {
          url,
          content_type: "json",
          http_method: "POST",
          authorization_header: authorizationHeader
        }
      }
    });
  }

  async deleteWebhook(fullName, hookId) {
    const id = Number(hookId);
    if (!Number.isSafeInteger(id) || id < 1) throw new GitVerseError("invalid GitVerse webhook id", 400);
    const [owner, repo] = repoParts(fullName);
    return this.request(`/repos/${owner}/${repo}/hooks/${id}`, { method: "DELETE" });
  }

  async listComments(fullName, issueNumber, { maxComments = 500 } = {}) {
    const [owner, repo] = repoParts(fullName);
    const result = [];
    const pages = Math.ceil(maxComments / 100) + 1;
    for (let page = 1; page <= pages; page += 1) {
      const batch = asArray(
        await this.request(`/repos/${owner}/${repo}/issues/${issueNumber}/comments?page=${page}&per_page=100`),
        "GitVerse comments"
      );
      result.push(...batch);
      if (result.length > maxComments) throw new GitVerseError("GitVerse issue has too many comments", 422);
      if (batch.length < 100) return result;
    }
    throw new GitVerseError("GitVerse comment pagination exceeded safe bound", 422);
  }

  async createComment(fullName, issueNumber, body) {
    const [owner, repo] = repoParts(fullName);
    return this.request(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      body: { body: String(body) }
    });
  }

  async updateComment(fullName, issueNumber, commentId, body) {
    const id = Number(commentId);
    if (!Number.isSafeInteger(id) || id < 1) throw new GitVerseError("invalid GitVerse comment id", 400);
    const [owner, repo] = repoParts(fullName);
    return this.request(`/repos/${owner}/${repo}/issues/${issueNumber}/comments/${id}`, {
      method: "PATCH",
      body: { body: String(body) }
    });
  }
}
