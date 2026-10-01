export class GitLabError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = "GitLabError";
    this.status = status;
  }
}

function projectId(value) {
  const raw = String(value);
  if (!raw || raw.length > 2048) throw new GitLabError("invalid GitLab project identity", 400);
  return encodeURIComponent(raw);
}

function fullSha(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) throw new GitLabError(`${label} is not a full commit SHA`, 400);
  return value.toLowerCase();
}

async function responseJson(response, label) {
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { throw new GitLabError(`${label} returned non-JSON`, 502); }
  if (!response.ok) {
    const detail = body && typeof body === "object" ? body.message : "request failed";
    throw new GitLabError(`${label} failed (${response.status}): ${typeof detail === "string" ? detail : "request failed"}`, response.status);
  }
  return body;
}

export class GitLabClient {
  constructor({ baseUrl, token, authMode = "private-token", fetchImpl = fetch }) {
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.apiBase = this.baseUrl + "/api/v4";
    this.token = token;
    this.authMode = authMode;
    this.fetchImpl = fetchImpl;
  }

  authHeaders() {
    if (this.authMode === "bearer") return { authorization: `Bearer ${this.token}` };
    if (this.authMode === "job-token") return { "job-token": this.token };
    return { "private-token": this.token };
  }

  async request(path, { method = "GET", body = null } = {}) {
    if (!path.startsWith("/")) throw new GitLabError("GitLab API path must be absolute", 500);
    const headers = {
      accept: "application/json",
      ...this.authHeaders(),
      "user-agent": "Peerivo-Reviewer-GitLab/0.4"
    };
    let payload;
    if (body !== null) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await this.fetchImpl(this.apiBase + path, {
      method,
      headers,
      body: payload,
      redirect: "error"
    });
    return responseJson(response, `GitLab API ${method} ${path.split("?")[0]}`);
  }

  async currentUser() {
    const user = await this.request("/user");
    if (!Number.isSafeInteger(user?.id) || user.id < 1 || typeof user?.username !== "string" || !user.username) {
      throw new GitLabError("GitLab returned invalid authenticated user identity", 502);
    }
    return user;
  }

  async currentJob() {
    const job = await this.request("/job");
    if (!Number.isSafeInteger(job?.id) || job.id < 1) {
      throw new GitLabError("GitLab returned invalid CI job identity", 502);
    }
    return job;
  }

  async manageableProjects({ maxProjects = 1000 } = {}) {
    const limit = Number(maxProjects);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new GitLabError("invalid project discovery limit", 500);

    const accessLevel = project => {
      const projectAccess = Number(project?.permissions?.project_access?.access_level);
      const groupAccess = Number(project?.permissions?.group_access?.access_level);
      const values = [projectAccess, groupAccess].filter(Number.isFinite);
      return values.length ? Math.max(...values) : null;
    };

    const result = [];
    let scanned = 0;
    const pages = Math.ceil(limit / 100) + 1;
    for (let page = 1; page <= pages; page += 1) {
      const batch = await this.request(
        `/projects?membership=true&archived=false&simple=false&order_by=path&sort=asc&per_page=100&page=${page}`
      );
      if (!Array.isArray(batch)) throw new GitLabError("GitLab projects response was not an array", 502);

      for (const item of batch) {
        scanned += 1;
        if (scanned > limit) throw new GitLabError(`GitLab account exceeds project discovery limit (${limit})`, 422);
        if (!Number.isSafeInteger(item?.id) || item.id < 1) continue;

        let project = item;
        let level = accessLevel(project);
        if (level === null) {
          project = await this.project(item.id);
          level = accessLevel(project);
        }
        if (level !== null && level >= 40) result.push(project);
      }

      if (batch.length < 100) return result;
    }
    throw new GitLabError("GitLab project pagination exceeded safe bound", 422);
  }

  async project(project) {
    return this.request(`/projects/${projectId(project)}`);
  }

  async mergeRequest(project, iid) {
    if (!Number.isSafeInteger(iid) || iid < 1) throw new GitLabError("invalid merge request iid", 400);
    return this.request(`/projects/${projectId(project)}/merge_requests/${iid}`);
  }

  async mergeRequestDiffs(project, iid, { maxFiles }) {
    const result = [];
    const pages = Math.ceil(maxFiles / 100) + 1;
    for (let page = 1; page <= pages; page += 1) {
      const batch = await this.request(
        `/projects/${projectId(project)}/merge_requests/${iid}/diffs?unidiff=true&per_page=100&page=${page}`
      );
      if (!Array.isArray(batch)) throw new GitLabError("GitLab merge request diffs response was not an array", 502);
      for (const item of batch) {
        if (item?.too_large === true || item?.collapsed === true) {
          throw new GitLabError("GitLab omitted merge request diff content; review coverage is incomplete", 422);
        }
      }
      result.push(...batch);
      if (result.length > maxFiles) throw new GitLabError(`merge request exceeds MAX_FILES (${maxFiles})`, 422);
      if (batch.length < 100) return result;
    }
    throw new GitLabError("GitLab diff pagination exceeded safe bound", 422);
  }

  async tree(project, sha, { maxFiles }) {
    const ref = fullSha(sha, "tree ref");
    const result = [];
    for (let page = 1; page <= 2000; page += 1) {
      const batch = await this.request(
        `/projects/${projectId(project)}/repository/tree?recursive=true&ref=${encodeURIComponent(ref)}&per_page=100&page=${page}`
      );
      if (!Array.isArray(batch)) throw new GitLabError("GitLab repository tree response was not an array", 502);
      for (const item of batch) {
        if (item?.type === "blob" && typeof item.path === "string") result.push(item.path);
      }
      if (result.length > maxFiles) throw new GitLabError(`repository exceeds MAX_FILES (${maxFiles})`, 422);
      if (batch.length < 100) return result;
    }
    throw new GitLabError("GitLab tree pagination exceeded safe bound", 422);
  }

  async fileContent(project, path, sha, { maxBytes }) {
    const ref = fullSha(sha, "file ref");
    const encodedPath = encodeURIComponent(String(path));
    const response = await this.fetchImpl(
      `${this.apiBase}/projects/${projectId(project)}/repository/files/${encodedPath}/raw?ref=${encodeURIComponent(ref)}`,
      {
        method: "GET",
        headers: { ...this.authHeaders(), "user-agent": "Peerivo-Reviewer-GitLab/0.4" },
        redirect: "error"
      }
    );
    if (!response.ok) {
      const text = await response.text();
      let detail = "request failed";
      try { detail = JSON.parse(text)?.message || detail; } catch {}
      throw new GitLabError(`GitLab raw file request failed (${response.status}): ${detail}`, response.status);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new GitLabError(`${path} exceeds byte limit`, 422);
    return bytes.toString("utf8");
  }

  async listWebhooks(project, { maxHooks = 500 } = {}) {
    const result = [];
    const pages = Math.ceil(maxHooks / 100) + 1;
    for (let page = 1; page <= pages; page += 1) {
      const batch = await this.request(`/projects/${projectId(project)}/hooks?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new GitLabError("GitLab webhooks response was not an array", 502);
      result.push(...batch);
      if (result.length > maxHooks) throw new GitLabError("GitLab project has too many webhooks", 422);
      if (batch.length < 100) return result;
    }
    throw new GitLabError("GitLab webhook pagination exceeded safe bound", 422);
  }

  async createWebhook(project, { url, token }) {
    return this.request(`/projects/${projectId(project)}/hooks`, {
      method: "POST",
      body: {
        url,
        token,
        name: "Peerivo Reviewer",
        merge_requests_events: true,
        push_events: false,
        enable_ssl_verification: true
      }
    });
  }

  async updateWebhook(project, hookId, { url, token }) {
    const id = Number(hookId);
    if (!Number.isSafeInteger(id) || id < 1) throw new GitLabError("invalid GitLab webhook id", 400);
    return this.request(`/projects/${projectId(project)}/hooks/${id}`, {
      method: "PUT",
      body: {
        url,
        token,
        name: "Peerivo Reviewer",
        merge_requests_events: true,
        push_events: false,
        enable_ssl_verification: true
      }
    });
  }

  async deleteWebhook(project, hookId) {
    const id = Number(hookId);
    if (!Number.isSafeInteger(id) || id < 1) throw new GitLabError("invalid GitLab webhook id", 400);
    return this.request(`/projects/${projectId(project)}/hooks/${id}`, { method: "DELETE" });
  }

  async setCommitStatus(project, sha, { state, description, ref = "", targetUrl = "", pipelineId = null }) {
    const commit = fullSha(sha, "status SHA");
    const allowed = new Set(["pending", "running", "success", "failed", "canceled", "skipped"]);
    if (!allowed.has(state)) throw new GitLabError("invalid commit status state", 400);
    const query = new URLSearchParams({
      state,
      name: "Peerivo Reviewer",
      description: String(description || "").slice(0, 255)
    });
    if (ref) query.set("ref", String(ref).slice(0, 255));
    if (targetUrl) query.set("target_url", String(targetUrl).slice(0, 255));
    if (pipelineId !== null) {
      const id = Number(pipelineId);
      if (!Number.isSafeInteger(id) || id < 1) throw new GitLabError("invalid pipeline id", 400);
      query.set("pipeline_id", String(id));
    }
    return this.request(`/projects/${projectId(project)}/statuses/${commit}?${query}`, { method: "POST" });
  }
}
