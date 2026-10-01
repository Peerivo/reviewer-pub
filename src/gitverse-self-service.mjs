import crypto from "node:crypto";
import { GitVerseClient, GitVerseError } from "./gitverse.mjs";
import { GitVerseInstallationStore } from "./gitverse-installations.mjs";
import { generateGitVersePkceVerifier, GitVerseOAuthClient, gitversePkceChallenge } from "./gitverse-oauth.mjs";

function secureEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !left || !right) return false;
  const a = crypto.createHash("sha256").update(left).digest();
  const b = crypto.createHash("sha256").update(right).digest();
  return crypto.timingSafeEqual(a, b);
}

function repositoryId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw Object.assign(new Error("invalid GitVerse repository id"), { status: 400 });
  return id;
}

function repositoryIdentity(value) {
  const repository = String(value || "").trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw Object.assign(new Error("invalid GitVerse repository identity"), { status: 400 });
  return repository;
}

export function createGitVerseSelfService({ config, fetchImpl = fetch, clock = Date.now, store = null } = {}) {
  const installationStore = store || new GitVerseInstallationStore({
    filename: config.installationsDb,
    encryptionKey: config.tokenEncryptionKey,
    clock
  });
  const oauth = new GitVerseOAuthClient({
    webBaseUrl: config.webBaseUrl,
    clientId: config.oauthClientId,
    clientSecret: config.oauthClientSecret,
    redirectUri: config.oauthRedirectUri,
    fetchImpl,
    clock
  });

  const client = accessToken => new GitVerseClient({
    apiBaseUrl: config.apiBaseUrl,
    token: accessToken,
    fetchImpl
  });

  function requireSession(sessionToken) {
    const installation = installationStore.getSessionInstallation(sessionToken);
    if (!installation) throw Object.assign(new Error("GitVerse installation session expired"), { status: 401 });
    return installation;
  }

  async function freshInstallation(installation) {
    if (installation.tokenExpiresAt > clock() + 60_000) return installation;
    const refreshed = await oauth.refresh(installation.refreshToken);
    return installationStore.updateTokens(installation.id, refreshed);
  }

  async function installationClient(installation) {
    const fresh = await freshInstallation(installation);
    return { installation: fresh, gitverse: client(fresh.accessToken) };
  }

  return {
    store: installationStore,

    beginOAuth() {
      const verifier = generateGitVersePkceVerifier();
      const state = installationStore.createOAuthState({ verifier, ttlMs: config.oauthStateTtlMs });
      return oauth.authorizeUrl({ state, codeChallenge: gitversePkceChallenge(verifier) });
    },

    async completeOAuth({ code, state }) {
      const verifier = installationStore.consumeOAuthState(String(state || ""));
      const tokens = await oauth.exchangeCode({ code, verifier });
      const gitverse = client(tokens.accessToken);
      const user = await gitverse.currentUser();
      const installation = installationStore.upsertInstallation({
        userId: user.id,
        login: user.login,
        ...tokens
      });
      const sessionToken = installationStore.createSession(installation.id, {
        ttlMs: config.installSessionTtlMs
      });
      return { sessionToken, login: installation.login, installationId: installation.id };
    },

    async repositorySelection(sessionToken) {
      const installation = requireSession(sessionToken);
      const { installation: fresh, gitverse } = await installationClient(installation);
      const repositories = await gitverse.manageableRepositories({ maxRepositories: config.maxDiscoverRepositories, login: fresh.login });
      const selected = new Set(installationStore.listRepositories(fresh.id).map(item => item.repositoryId));
      return {
        login: fresh.login,
        csrf: installationStore.csrfToken(sessionToken),
        repositories: repositories
          .filter(item => Number.isSafeInteger(item?.id) && item.id > 0
            && typeof item?.full_name === "string"
            && item?.permissions?.admin === true
            && item?.archived !== true
            && item?.disabled !== true)
          .map(item => ({
            id: item.id,
            name: String(item.name || item.full_name),
            fullName: item.full_name,
            visibility: String(item.visibility || (item.private ? "private" : "public")),
            selected: selected.has(item.id)
          }))
      };
    },

    async applyRepositories({ sessionToken, csrf, repositoryIds }) {
      const installation = requireSession(sessionToken);
      if (!installationStore.verifyCsrf(sessionToken, String(csrf || ""))) {
        throw Object.assign(new Error("invalid CSRF token"), { status: 403 });
      }
      const selectedIds = [...new Set((repositoryIds || []).map(repositoryId))];
      if (selectedIds.length > config.maxInstallRepositories) {
        throw Object.assign(new Error(`too many repositories selected; maximum is ${config.maxInstallRepositories}`), { status: 400 });
      }

      const { installation: fresh, gitverse } = await installationClient(installation);
      const manageable = await gitverse.manageableRepositories({ maxRepositories: config.maxDiscoverRepositories, login: fresh.login });
      const allowed = new Map();
      for (const item of manageable) {
        if (Number.isSafeInteger(item?.id) && item.id > 0
            && typeof item?.full_name === "string"
            && item?.permissions?.admin === true
            && item?.archived !== true
            && item?.disabled !== true) {
          allowed.set(item.id, item);
        }
      }
      for (const id of selectedIds) {
        if (!allowed.has(id)) throw Object.assign(new Error(`GitVerse repository ${id} is not selectable`), { status: 403 });
      }

      const current = installationStore.listRepositories(fresh.id);
      const wanted = new Set(selectedIds);
      const removed = [];
      for (const installed of current) {
        if (wanted.has(installed.repositoryId)) continue;
        try {
          await gitverse.deleteWebhook(installed.fullName, installed.webhookId);
        } catch (error) {
          if (!(error instanceof GitVerseError) || error.status !== 404) throw error;
        }
        installationStore.deleteRepository(installed.repositoryId);
        removed.push(installed.fullName);
      }

      const installed = [];
      for (const id of selectedIds) {
        const repository = allowed.get(id);
        const fullName = repositoryIdentity(repository.full_name);
        const existing = installationStore.getRepository(id);
        if (existing && existing.installationId !== fresh.id) {
          throw Object.assign(new Error(`GitVerse repository ${id} is already attached to another Reviewer installation`), { status: 409 });
        }
        const webhookSecret = existing?.webhookSecret || `pvrwh_${crypto.randomBytes(32).toString("base64url")}`;
        const authorizationHeader = `Bearer ${webhookSecret}`;
        const hooks = await gitverse.listWebhooks(fullName);
        const hook = hooks.find(item => item?.id === existing?.webhookId)
          || hooks.find(item => item?.config?.url === `${config.webhookUrl}/${id}`);
        const webhookUrl = `${config.webhookUrl}/${id}`;
        const saved = hook
          ? await gitverse.updateWebhook(fullName, hook.id, { url: webhookUrl, authorizationHeader })
          : await gitverse.createWebhook(fullName, { url: webhookUrl, authorizationHeader });
        if (!Number.isSafeInteger(saved?.id) || saved.id < 1) throw new Error("GitVerse returned invalid webhook id");
        installationStore.upsertRepository({
          repositoryId: id,
          installationId: fresh.id,
          fullName,
          webhookId: saved.id,
          webhookSecret
        });
        installed.push(fullName);
      }

      return { installed, removed, selectedCount: selectedIds.length };
    },

    async repairRepository({ fullName, branches = [], workflowPath = "", workflowContent = "", touchPath = "", touchContent = "" } = {}) {
      const repositoryName = repositoryIdentity(fullName);
      const owner = repositoryName.split("/")[0];
      const installation = installationStore.getRepositoryByFullName(repositoryName)?.installationId
        ? installationStore.getInstallation(installationStore.getRepositoryByFullName(repositoryName).installationId)
        : installationStore.findInstallationByLogin(owner);
      if (!installation) throw Object.assign(new Error("GitVerse OAuth installation not found for repair"), { status: 404 });

      const { installation: fresh, gitverse } = await installationClient(installation);
      const repository = await gitverse.repository(repositoryName);
      if (!Number.isSafeInteger(repository?.id) || repository.id < 1 || repository?.permissions?.admin !== true) {
        throw Object.assign(new Error("GitVerse repository is not admin-manageable for repair"), { status: 403 });
      }

      const id = repository.id;
      const existing = installationStore.getRepository(id);
      const webhookSecret = existing?.webhookSecret || `pvrwh_${crypto.randomBytes(32).toString("base64url")}`;
      const authorizationHeader = `Bearer ${webhookSecret}`;
      const webhookUrl = `${config.webhookUrl}/${id}`;
      const hooks = await gitverse.listWebhooks(repositoryName);
      const hook = hooks.find(item => item?.id === existing?.webhookId)
        || hooks.find(item => item?.config?.url === webhookUrl);
      const saved = hook
        ? await gitverse.updateWebhook(repositoryName, hook.id, { url: webhookUrl, authorizationHeader })
        : await gitverse.createWebhook(repositoryName, { url: webhookUrl, authorizationHeader });
      if (!Number.isSafeInteger(saved?.id) || saved.id < 1) throw new Error("GitVerse returned invalid webhook id during repair");
      installationStore.upsertRepository({
        repositoryId: id,
        installationId: fresh.id,
        fullName: repositoryName,
        webhookId: saved.id,
        webhookSecret
      });

      const updatedBranches = [];
      for (const branch of branches) {
        const branchName = String(branch || "").trim();
        if (!branchName || !workflowPath) continue;
        let current = null;
        try {
          current = await gitverse.contentEntry(repositoryName, workflowPath, branchName);
        } catch (error) {
          if (!(error instanceof GitVerseError) || error.status !== 404) throw error;
        }
        const currentText = current?.encoding === "base64" && typeof current?.content === "string"
          ? Buffer.from(current.content.replace(/\s+/g, ""), "base64").toString("utf8")
          : "";
        if (currentText !== workflowContent) {
          await gitverse.putFile(repositoryName, workflowPath, {
            branch: branchName,
            content: workflowContent,
            message: "chore: repair Peerivo Reviewer GitVerse workflow",
            sha: current?.sha || ""
          });
          updatedBranches.push(branchName);
        }
      }

      if (touchPath && touchContent && branches.length > 1) {
        const branchName = String(branches[branches.length - 1] || "").trim();
        let current = null;
        try {
          current = await gitverse.contentEntry(repositoryName, touchPath, branchName);
        } catch (error) {
          if (!(error instanceof GitVerseError) || error.status !== 404) throw error;
        }
        await gitverse.putFile(repositoryName, touchPath, {
          branch: branchName,
          content: touchContent,
          message: "chore: retrigger Peerivo Reviewer GitVerse E2E",
          sha: current?.sha || ""
        });
        updatedBranches.push(branchName + ":trigger");
      }

      return {
        repositoryId: id,
        fullName: repositoryName,
        webhookId: saved.id,
        webhookEvents: saved.events || [],
        webhookLastResponseStatus: saved.last_response_status || "",
        updatedBranches
      };
    },

    authenticateRepositoryWebhook({ repositoryId: rawRepositoryId, authorizationHeader }) {
      const id = repositoryId(rawRepositoryId);
      const record = installationStore.getRepository(id);
      if (!record) return null;
      const expected = `Bearer ${record.webhookSecret}`;
      if (!secureEqual(expected, String(authorizationHeader || ""))) {
        throw Object.assign(new Error("invalid webhook authorization"), { status: 401 });
      }
      return {
        source: "oauth",
        repositoryId: id,
        fullName: record.fullName,
        installationId: record.installationId
      };
    },

    async gitverseForInstallation(installationId) {
      const installation = installationStore.getInstallation(installationId);
      if (!installation) throw Object.assign(new Error("GitVerse installation not found"), { status: 403 });
      return (await installationClient(installation)).gitverse;
    },

    async disconnect({ sessionToken, csrf }) {
      const installation = requireSession(sessionToken);
      if (!installationStore.verifyCsrf(sessionToken, String(csrf || ""))) {
        throw Object.assign(new Error("invalid CSRF token"), { status: 403 });
      }
      const warnings = [];
      try {
        const { installation: fresh, gitverse } = await installationClient(installation);
        for (const repository of installationStore.listRepositories(fresh.id)) {
          try {
            await gitverse.deleteWebhook(repository.fullName, repository.webhookId);
          } catch (error) {
            if (!(error instanceof GitVerseError) || error.status !== 404) warnings.push("one or more repository webhooks could not be removed");
          }
        }
      } catch {
        warnings.push("GitVerse access could not be refreshed during disconnect");
      }
      installationStore.deleteInstallation(installation.id);
      warnings.push("OAuth grant remains valid in GitVerse until the user revokes Reviewer in Authorized Applications");
      return { disconnected: true, warnings: [...new Set(warnings)] };
    },

    close() { installationStore.close(); }
  };
}
