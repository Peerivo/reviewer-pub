import fs from "node:fs";
import { GitLabError } from "./gitlab.mjs";
import { createGitLabSelfService } from "./gitlab-self-service.mjs";

export const GITLAB_CATALOG_DESCRIPTION = "Peerivo Reviewer — fail-closed security review for GitLab merge requests. Checks secrets, CI/CD permissions, supply chain, dependencies, migrations and runtime boundaries without executing MR code.";

function encoded(value) { return encodeURIComponent(String(value)); }

async function maybeProject(gitlab, path) {
  try { return await gitlab.request(`/projects/${encoded(path)}`); }
  catch (error) {
    if (error instanceof GitLabError && error.status === 404) return null;
    throw error;
  }
}

async function maybeFile(gitlab, projectId, filePath, branch) {
  try {
    return await gitlab.request(`/projects/${projectId}/repository/files/${encoded(filePath)}?ref=${encoded(branch)}`);
  } catch (error) {
    if (error instanceof GitLabError && error.status === 404) return null;
    throw error;
  }
}

async function putFile(gitlab, projectId, branch, filePath, content, commitMessage) {
  const existing = await maybeFile(gitlab, projectId, filePath, branch);
  if (existing?.content) {
    const current = Buffer.from(String(existing.content).replace(/\n/g, ""), "base64").toString("utf8");
    if (current === content) return { changed: false, filePath };
  }
  const body = { branch, content, commit_message: commitMessage };
  if (existing?.last_commit_id) body.last_commit_id = existing.last_commit_id;
  await gitlab.request(`/projects/${projectId}/repository/files/${encoded(filePath)}`, {
    method: existing ? "PUT" : "POST",
    body
  });
  return { changed: true, filePath };
}

async function waitForNamespace(gitlab, projectId, namespace, { attempts = 90, delayMs = 1000, sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let latest = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    latest = await maybeProject(gitlab, projectId);
    if (String(latest?.path_with_namespace || "").startsWith(`${namespace}/`)) return latest;
    if (attempt + 1 < attempts && delayMs > 0) await sleepImpl(delayMs);
  }
  return latest;
}

async function uploadProjectAvatar(gitlab, projectId, avatarPath) {
  const bytes = fs.readFileSync(avatarPath);
  if (bytes.length < 1 || bytes.length > 200 * 1024) throw new Error("GitLab catalog avatar must be between 1 byte and 200 KB");
  const form = new FormData();
  form.set("avatar", new Blob([bytes], { type: "image/jpeg" }), "peerivo-reviewer.jpg");
  const response = await gitlab.fetchImpl(`${gitlab.apiBase}/projects/${projectId}`, {
    method: "PUT",
    headers: {
      accept: "application/json",
      ...gitlab.authHeaders(),
      "user-agent": "Peerivo-Reviewer-GitLab-Catalog/1.0"
    },
    body: form,
    redirect: "error"
  });
  if (!response.ok) throw new GitLabError(`GitLab catalog avatar upload failed (${response.status})`, response.status);
  const body = await response.json();
  if (!body?.avatar_url) throw new Error("GitLab did not confirm catalog avatar");
  return body;
}

async function maybeTag(gitlab, projectId, tag) {
  try { return await gitlab.request(`/projects/${projectId}/repository/tags/${encoded(tag)}`); }
  catch (error) {
    if (error instanceof GitLabError && error.status === 404) return null;
    throw error;
  }
}

export async function bootstrapGitLabCatalog({
  oauthConfig,
  actorUsername,
  namespacePath,
  ownerUsername,
  transferFromPath = "",
  catalogProjectId = null,
  projectPath = "peerivo-reviewer",
  version = "1.0.0",
  assetsRoot = new URL("../gitlab-catalog/", import.meta.url),
  avatarPath = null,
  transferPollAttempts = 90,
  transferPollDelayMs = 1000,
  sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms)),
  fetchImpl = fetch
} = {}) {
  const actor = String(actorUsername || ownerUsername || "").trim();
  const namespace = String(namespacePath || ownerUsername || actor).trim();
  if (!oauthConfig) throw new Error("GitLab OAuth configuration is required");
  if (!actor) throw new Error("GitLab catalog actor username is required");
  if (!namespace) throw new Error("GitLab catalog namespace path is required");

  const runtime = createGitLabSelfService({ config: oauthConfig, fetchImpl });
  try {
    const row = runtime.store.db.prepare(
      "SELECT id FROM gitlab_installations WHERE username = ? ORDER BY updated_at DESC LIMIT 1"
    ).get(actor);
    if (!row) throw new Error(`No GitLab OAuth installation found for ${actor}`);

    const gitlab = await runtime.gitlabForInstallation(row.id);
    const fullPath = `${namespace}/${projectPath}`;
    let project = await maybeProject(gitlab, fullPath);

    const previousPath = String(transferFromPath || "").trim();
    const stableProjectId = Number(catalogProjectId);
    let previous = null;

    if (!project && Number.isSafeInteger(stableProjectId) && stableProjectId > 0) {
      previous = await maybeProject(gitlab, stableProjectId);
      if (String(previous?.path_with_namespace || "").startsWith(`${namespace}/`)) project = previous;
    }
    if (!project && !previous && previousPath && previousPath !== fullPath) {
      previous = await maybeProject(gitlab, previousPath);
    }

    if (!project && previous) {
      if (!Number.isSafeInteger(previous?.id) || previous.id < 1) throw new Error("GitLab returned invalid source catalog project id");
      const currentPath = String(previous.path_with_namespace || "");
      if (currentPath.startsWith(`${namespace}/`)) {
        project = previous;
      } else {
        let transferError = null;
        try {
          await gitlab.request(`/projects/${previous.id}/transfer`, {
            method: "PUT",
            body: { namespace }
          });
        } catch (error) {
          // GitLab.com project transfers are asynchronous. A retry may see the
          // previous transfer still in progress; poll the stable project id
          // before deciding the transfer failed.
          if (!(error instanceof GitLabError) || ![400, 409].includes(error.status)) throw error;
          transferError = error;
        }
        project = await waitForNamespace(gitlab, previous.id, namespace, {
          attempts: transferPollAttempts,
          delayMs: transferPollDelayMs,
          sleepImpl
        });
        if (!String(project?.path_with_namespace || "").startsWith(`${namespace}/`)) {
          if (transferError) throw transferError;
          throw new Error(`GitLab catalog transfer did not complete in time: expected namespace ${namespace}`);
        }
      }

      if (project.path_with_namespace !== fullPath) {
        project = await gitlab.request(`/projects/${previous.id}`, {
          method: "PUT",
          body: { path: projectPath, name: "Peerivo Reviewer" }
        });
        if (project?.path_with_namespace !== fullPath) {
          throw new Error(`GitLab catalog rename is not complete: expected ${fullPath}`);
        }
      }
    }

    if (project && project.path_with_namespace !== fullPath) {
      const currentPath = String(project.path_with_namespace || "");
      if (!currentPath.startsWith(`${namespace}/`)) {
        throw new Error(`GitLab catalog resolved outside expected namespace: ${currentPath || "unknown"}`);
      }
      project = await gitlab.request(`/projects/${project.id}`, {
        method: "PUT",
        body: { path: projectPath, name: "Peerivo Reviewer" }
      });
      if (project?.path_with_namespace !== fullPath) {
        throw new Error(`GitLab catalog rename is not complete: expected ${fullPath}`);
      }
    }

    if (!project) {
      project = await gitlab.request("/projects", {
        method: "POST",
        body: {
          name: "Peerivo Reviewer",
          path: projectPath,
          description: GITLAB_CATALOG_DESCRIPTION,
          visibility: "public",
          initialize_with_readme: true,
          default_branch: "main",
          cicd_catalog_enabled: true,
          auto_devops_enabled: false,
          topics: ["security", "devsecops", "ci-cd", "code-review"]
        }
      });
    }

    if (!Number.isSafeInteger(project?.id) || project.id < 1) throw new Error("GitLab returned invalid catalog project id");

    project = await gitlab.request(`/projects/${project.id}`, {
      method: "PUT",
      body: {
        description: GITLAB_CATALOG_DESCRIPTION,
        visibility: "public",
        cicd_catalog_enabled: true,
        auto_devops_enabled: false,
        topics: ["security", "devsecops", "ci-cd", "code-review"]
      }
    });

    if (avatarPath && !project.avatar_url) {
      project = await uploadProjectAvatar(gitlab, project.id, avatarPath);
    }

    const branch = String(project.default_branch || "main");
    const files = [
      ["README.md", "README.md", "docs: publish Peerivo Reviewer catalog page"],
      ["templates/reviewer.yml", "templates/reviewer.yml", "feat: publish Peerivo Reviewer component"],
      [".gitlab-ci.yml", ".gitlab-ci.yml", "ci: publish Peerivo Reviewer component releases"]
    ];
    const changes = [];
    for (const [sourcePath, targetPath, message] of files) {
      const content = fs.readFileSync(new URL(sourcePath, assetsRoot), "utf8");
      changes.push(await putFile(gitlab, project.id, branch, targetPath, content, message));
    }

    let tag = await maybeTag(gitlab, project.id, version);
    if (!tag) {
      tag = await gitlab.request(`/projects/${project.id}/repository/tags`, {
        method: "POST",
        body: { tag_name: version, ref: branch }
      });
    }

    const pipelines = await gitlab.request(`/projects/${project.id}/pipelines?ref=${encoded(version)}&per_page=5`);
    return {
      projectId: project.id,
      projectPath: project.path_with_namespace || fullPath,
      projectUrl: project.web_url || `https://gitlab.com/${fullPath}`,
      catalogEnabled: project.cicd_catalog_enabled === true,
      version,
      changes,
      tag: tag?.name || version,
      pipelines: Array.isArray(pipelines) ? pipelines.map(item => ({ id: item.id, status: item.status, webUrl: item.web_url })) : []
    };
  } finally {
    runtime.close();
  }
}
