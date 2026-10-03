import crypto from "node:crypto";
import { verifySharedSecret } from "./crypto.mjs";
import { GitLabClient, GitLabError } from "./gitlab.mjs";
import { GitLabInstallationStore } from "./gitlab-installations.mjs";
import { generatePkceVerifier, GitLabOAuthClient, pkceChallenge } from "./gitlab-oauth.mjs";

function repositoryIdentity(value) {
  const repository = String(value || "").trim();
  if (!/^[^/\s]+(?:\/[^/\s]+)+$/.test(repository)) throw new Error("invalid GitLab repository identity");
  return repository;
}

function projectId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw Object.assign(new Error("invalid GitLab project id"), { status: 400 });
  return id;
}

export function createGitLabSelfService({ config, fetchImpl = fetch, clock = Date.now, store = null } = {}) {
  const installationStore = store || new GitLabInstallationStore({
    filename: config.installationsDb,
    encryptionKey: config.tokenEncryptionKey,
    clock
  });
  const oauth = new GitLabOAuthClient({
    baseUrl: config.gitlabBaseUrl,
    clientId: config.oauthClientId,
    clientSecret: config.oauthClientSecret,
    redirectUri: config.oauthRedirectUri,
    fetchImpl,
    clock
  });

  function client(accessToken) {
    return new GitLabClient({
      baseUrl: config.gitlabBaseUrl,
      token: accessToken,
      authMode: "bearer",
      fetchImpl
    });
  }

  function requireSession(sessionToken) {
    const installation = installationStore.getSessionInstallation(sessionToken);
    if (!installation) throw Object.assign(new Error("GitLab installation session expired"), { status: 401 });
    return installation;
  }

  async function freshInstallation(installation) {
    if (installation.tokenExpiresAt > clock() + 60_000) return installation;
    const refreshed = await oauth.refresh(installation.refreshToken);
    return installationStore.updateTokens(installation.id, refreshed);
  }

  async function installationClient(installation) {
    const fresh = await freshInstallation(installation);
    return { installation: fresh, gitlab: client(fresh.accessToken) };
  }

  return {
    store: installationStore,

    beginOAuth() {
      const verifier = generatePkceVerifier();
      const state = installationStore.createOAuthState({
        verifier,
        ttlMs: config.oauthStateTtlMs
      });
      return oauth.authorizeUrl({ state, codeChallenge: pkceChallenge(verifier) });
    },

    async completeOAuth({ code, state }) {
      const verifier = installationStore.consumeOAuthState(String(state || ""));
      const tokens = await oauth.exchangeCode({ code, verifier });
      const gitlab = client(tokens.accessToken);
      const user = await gitlab.currentUser();
      const installation = installationStore.upsertInstallation({
        baseUrl: config.gitlabBaseUrl,
        userId: user.id,
        username: user.username,
        ...tokens
      });
      const sessionToken = installationStore.createSession(installation.id, {
        ttlMs: config.installSessionTtlMs
      });
      return {
        sessionToken,
        username: installation.username,
        installationId: installation.id
      };
    },

    async projectSelection(sessionToken) {
      const installation = requireSession(sessionToken);
      const { installation: fresh, gitlab } = await installationClient(installation);
      const projects = await gitlab.manageableProjects({ maxProjects: config.maxDiscoverProjects });
      const selected = new Set(installationStore.listProjects(fresh.id).map(item => item.projectId));
      return {
        username: fresh.username,
        csrf: installationStore.csrfToken(sessionToken),
        projects: projects
          .filter(item => Number.isSafeInteger(item?.id) && item.id > 0 && typeof item?.path_with_namespace === "string")
          .map(item => ({
            id: item.id,
            name: String(item.name || item.path_with_namespace),
            pathWithNamespace: item.path_with_namespace,
            visibility: String(item.visibility || ""),
            selected: selected.has(item.id)
          }))
      };
    },

    async applyProjects({ sessionToken, csrf, projectIds }) {
      const installation = requireSession(sessionToken);
      if (!installationStore.verifyCsrf(sessionToken, String(csrf || ""))) {
        throw Object.assign(new Error("invalid CSRF token"), { status: 403 });
      }
      const selectedIds = [...new Set((projectIds || []).map(projectId))];
      if (selectedIds.length > config.maxInstallProjects) {
        throw Object.assign(new Error(`too many projects selected; maximum is ${config.maxInstallProjects}`), { status: 400 });
      }

      const { installation: fresh, gitlab } = await installationClient(installation);
      const manageable = await gitlab.manageableProjects({ maxProjects: config.maxDiscoverProjects });
      const allowed = new Map();
      for (const item of manageable) {
        if (Number.isSafeInteger(item?.id) && item.id > 0 && typeof item?.path_with_namespace === "string") {
          allowed.set(item.id, item);
        }
      }
      for (const id of selectedIds) {
        if (!allowed.has(id)) throw Object.assign(new Error(`GitLab project ${id} is not selectable`), { status: 403 });
      }

      const currentlyInstalled = installationStore.listProjects(fresh.id);
      const wanted = new Set(selectedIds);
      const removed = [];
      for (const installed of currentlyInstalled) {
        if (wanted.has(installed.projectId)) continue;
        try {
          await gitlab.deleteWebhook(installed.projectId, installed.webhookId);
        } catch (error) {
          if (!(error instanceof GitLabError) || error.status !== 404) throw error;
        }
        installationStore.deleteProject(installed.projectId);
        removed.push(installed.pathWithNamespace);
      }

      const installed = [];
      for (const id of selectedIds) {
        const project = allowed.get(id);
        const repo = repositoryIdentity(project.path_with_namespace);
        const existing = installationStore.getProject(id);
        if (existing && existing.installationId !== fresh.id) {
          throw Object.assign(new Error(`GitLab project ${id} is already attached to another Reviewer installation`), { status: 409 });
        }
        const webhookSecret = existing?.webhookSecret || `pvrwh_${crypto.randomBytes(32).toString("base64url")}`;
        const hooks = await gitlab.listWebhooks(id);
        const hook = hooks.find(item => item?.id === existing?.webhookId)
          || hooks.find(item => item?.url === config.webhookUrl && item?.name === "Peerivo Reviewer");
        const saved = hook
          ? await gitlab.updateWebhook(id, hook.id, { url: config.webhookUrl, token: webhookSecret })
          : await gitlab.createWebhook(id, { url: config.webhookUrl, token: webhookSecret });
        if (!Number.isSafeInteger(saved?.id) || saved.id < 1) throw new Error("GitLab returned invalid webhook id");
        installationStore.upsertProject({
          projectId: id,
          installationId: fresh.id,
          pathWithNamespace: repo,
          webhookId: saved.id,
          webhookSecret
        });
        installed.push(repo);
      }

      return { installed, removed, selectedCount: selectedIds.length };
    },

    authenticateProjectWebhook({ projectId: rawProjectId, repo, tokenHeader }) {
      const id = projectId(rawProjectId);
      const record = installationStore.getProject(id);
      if (!record) return null;
      if (record.pathWithNamespace !== repositoryIdentity(repo)) {
        throw Object.assign(new Error("GitLab webhook repository identity mismatch"), { status: 403 });
      }
      if (!verifySharedSecret({
        secret: record.webhookSecret,
        supplied: typeof tokenHeader === "string" ? tokenHeader : ""
      })) {
        throw Object.assign(new Error("invalid webhook token"), { status: 401 });
      }
      return {
        source: "oauth",
        projectId: id,
        repo: record.pathWithNamespace,
        installationId: record.installationId
      };
    },

    async gitlabForInstallation(installationId) {
      const installation = installationStore.getInstallation(installationId);
      if (!installation) throw Object.assign(new Error("GitLab installation not found"), { status: 403 });
      return (await installationClient(installation)).gitlab;
    },

    async disconnect({ sessionToken, csrf }) {
      const installation = requireSession(sessionToken);
      if (!installationStore.verifyCsrf(sessionToken, String(csrf || ""))) {
        throw Object.assign(new Error("invalid CSRF token"), { status: 403 });
      }

      const warnings = [];
      let fresh = installation;
      let gitlab = null;
      try {
        const resolved = await installationClient(installation);
        fresh = resolved.installation;
        gitlab = resolved.gitlab;
        for (const project of installationStore.listProjects(fresh.id)) {
          try {
            await gitlab.deleteWebhook(project.projectId, project.webhookId);
          } catch (error) {
            if (!(error instanceof GitLabError) || error.status !== 404) warnings.push("one or more project webhooks could not be removed");
          }
        }
      } catch {
        warnings.push("GitLab access could not be refreshed during disconnect");
      }

      try {
        await oauth.revoke(fresh.accessToken);
      } catch {
        warnings.push("GitLab OAuth grant could not be revoked automatically");
      }

      installationStore.deleteInstallation(fresh.id);
      return { disconnected: true, warnings: [...new Set(warnings)] };
    },

    close() {
      installationStore.close();
    }
  };
}
