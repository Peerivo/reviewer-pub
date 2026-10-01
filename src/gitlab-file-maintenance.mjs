import { pathToFileURL } from "node:url";
import { loadGitLabOAuthConfig } from "./config.mjs";
import { createGitLabSelfService } from "./gitlab-self-service.mjs";

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function decodeContent(raw) {
  const value = String(raw || "");
  if (!value) return "";
  return Buffer.from(value.replace(/\n/g, ""), "base64").toString("utf8");
}

export async function patchGitLabFile({
  projectPath,
  branch,
  filePath,
  content,
  commitMessage,
  config = loadGitLabOAuthConfig(),
  fetchImpl = fetch
}) {
  const runtime = createGitLabSelfService({ config, fetchImpl });
  try {
    const row = runtime.store.db.prepare(
      "SELECT project_id, installation_id, path_with_namespace FROM gitlab_projects WHERE path_with_namespace = ? AND active = 1"
    ).get(String(projectPath));

    if (!row) throw new Error(`GitLab project is not connected to Reviewer: ${projectPath}`);

    const gitlab = await runtime.gitlabForInstallation(row.installation_id);
    const encodedPath = encodeURIComponent(String(filePath));
    const encodedRef = encodeURIComponent(String(branch));
    const metadata = await gitlab.request(
      `/projects/${row.project_id}/repository/files/${encodedPath}?ref=${encodedRef}`
    );

    const current = decodeContent(metadata?.content);
    if (current === content) {
      return { changed: false, projectId: row.project_id, path: filePath, branch };
    }

    const body = {
      branch,
      content,
      commit_message: commitMessage
    };
    if (typeof metadata?.last_commit_id === "string" && metadata.last_commit_id) {
      body.last_commit_id = metadata.last_commit_id;
    }

    await gitlab.request(
      `/projects/${row.project_id}/repository/files/${encodedPath}`,
      { method: "PUT", body }
    );

    return { changed: true, projectId: row.project_id, path: filePath, branch };
  } finally {
    runtime.close();
  }
}

export async function main() {
  const projectPath = requiredEnv("GITLAB_MAINTENANCE_PROJECT");
  const branch = requiredEnv("GITLAB_MAINTENANCE_BRANCH");
  const filePath = requiredEnv("GITLAB_MAINTENANCE_PATH");
  const contentB64 = requiredEnv("GITLAB_MAINTENANCE_CONTENT_B64");
  const commitMessage = String(process.env.GITLAB_MAINTENANCE_COMMIT_MESSAGE || "chore: update GitLab CI").trim();

  const content = Buffer.from(contentB64, "base64").toString("utf8");
  if (!content) throw new Error("GITLAB_MAINTENANCE_CONTENT_B64 decoded to empty content");

  const result = await patchGitLabFile({
    projectPath,
    branch,
    filePath,
    content,
    commitMessage
  });

  process.stdout.write(
    `GitLab maintenance ${result.changed ? "updated" : "already current"}: ${projectPath}@${branch}:${filePath}\n`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`GitLab maintenance failed: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
