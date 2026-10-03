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
  projectPath = "peerivo-reviewer",
  version = "1.0.0",
  assetsRoot = new URL("../gitlab-catalog/", import.meta.url),
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
