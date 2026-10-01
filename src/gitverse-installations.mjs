import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function secureEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !left || !right) return false;
  const a = crypto.createHash("sha256").update(left).digest();
  const b = crypto.createHash("sha256").update(right).digest();
  return crypto.timingSafeEqual(a, b);
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error(`invalid ${label}`);
  return id;
}

function repositoryIdentity(value) {
  const repository = String(value || "").trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error("invalid GitVerse repository identity");
  return repository;
}

export class GitVerseInstallationStore {
  constructor({ filename, encryptionKey, clock = Date.now } = {}) {
    if (!filename) throw new Error("GitVerse installation database filename is required");
    if (Buffer.byteLength(String(encryptionKey || "")) < 32) {
      throw new Error("GitVerse token encryption key must contain at least 32 bytes");
    }
    this.clock = clock;
    this.key = crypto.createHash("sha256").update(String(encryptionKey)).digest();
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gitverse_oauth_states (
        state_hash TEXT PRIMARY KEY,
        verifier_cipher TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gitverse_installations (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        login TEXT NOT NULL,
        access_token_cipher TEXT NOT NULL,
        refresh_token_cipher TEXT NOT NULL,
        token_expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(user_id)
      );
      CREATE TABLE IF NOT EXISTS gitverse_sessions (
        token_hash TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL REFERENCES gitverse_installations(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gitverse_repositories (
        repository_id INTEGER PRIMARY KEY,
        installation_id TEXT NOT NULL REFERENCES gitverse_installations(id) ON DELETE CASCADE,
        full_name TEXT NOT NULL UNIQUE,
        webhook_id INTEGER NOT NULL,
        webhook_secret_cipher TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS gitverse_repositories_installation_idx
        ON gitverse_repositories(installation_id, active);
    `);
  }

  close() { this.db.close(); }

  encrypt(value, aad) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(String(aad)));
    const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
  }

  decrypt(value, aad) {
    const parts = String(value || "").split(".");
    if (parts.length !== 4 || parts[0] !== "v1") throw new Error("invalid encrypted GitVerse credential");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(parts[1], "base64url"));
    decipher.setAAD(Buffer.from(String(aad)));
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8");
  }

  prune() {
    const now = this.clock();
    this.db.prepare("DELETE FROM gitverse_oauth_states WHERE expires_at <= ?").run(now);
    this.db.prepare("DELETE FROM gitverse_sessions WHERE expires_at <= ?").run(now);
  }

  createOAuthState({ verifier, ttlMs = 10 * 60 * 1000 } = {}) {
    if (typeof verifier !== "string" || verifier.length < 43 || verifier.length > 128) {
      throw new Error("PKCE verifier must contain 43 to 128 characters");
    }
    this.prune();
    const state = crypto.randomBytes(32).toString("base64url");
    const stateHash = hash(state);
    this.db.prepare("INSERT INTO gitverse_oauth_states (state_hash, verifier_cipher, expires_at) VALUES (?, ?, ?)")
      .run(stateHash, this.encrypt(verifier, `oauth:${stateHash}`), this.clock() + ttlMs);
    return state;
  }

  consumeOAuthState(state) {
    const stateHash = hash(state);
    const row = this.db.prepare("SELECT verifier_cipher, expires_at FROM gitverse_oauth_states WHERE state_hash = ?").get(stateHash);
    this.db.prepare("DELETE FROM gitverse_oauth_states WHERE state_hash = ?").run(stateHash);
    if (!row || row.expires_at <= this.clock()) {
      throw Object.assign(new Error("invalid or expired OAuth state"), { status: 400 });
    }
    return this.decrypt(row.verifier_cipher, `oauth:${stateHash}`);
  }

  upsertInstallation({ userId, login, accessToken, refreshToken, tokenExpiresAt }) {
    const normalizedUserId = positiveId(userId, "GitVerse user id");
    if (!accessToken || !refreshToken) throw new Error("GitVerse OAuth tokens are required");
    if (!Number.isSafeInteger(tokenExpiresAt) || tokenExpiresAt <= this.clock()) throw new Error("GitVerse OAuth token expiry is invalid");
    const now = this.clock();
    const existing = this.db.prepare("SELECT id FROM gitverse_installations WHERE user_id = ?").get(normalizedUserId);
    const id = existing?.id || crypto.randomUUID();
    const access = this.encrypt(accessToken, `installation:${id}:access`);
    const refresh = this.encrypt(refreshToken, `installation:${id}:refresh`);

    if (existing) {
      this.db.prepare(`
        UPDATE gitverse_installations
        SET login = ?, access_token_cipher = ?, refresh_token_cipher = ?, token_expires_at = ?, updated_at = ?
        WHERE id = ?
      `).run(String(login || "").slice(0, 255), access, refresh, tokenExpiresAt, now, id);
    } else {
      this.db.prepare(`
        INSERT INTO gitverse_installations
          (id, user_id, login, access_token_cipher, refresh_token_cipher, token_expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, normalizedUserId, String(login || "").slice(0, 255), access, refresh, tokenExpiresAt, now, now);
    }
    return this.getInstallation(id);
  }

  getInstallation(id) {
    const row = this.db.prepare("SELECT * FROM gitverse_installations WHERE id = ?").get(String(id));
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      login: row.login,
      accessToken: this.decrypt(row.access_token_cipher, `installation:${row.id}:access`),
      refreshToken: this.decrypt(row.refresh_token_cipher, `installation:${row.id}:refresh`),
      tokenExpiresAt: row.token_expires_at
    };
  }

  findInstallationByLogin(login) {
    const normalized = String(login || "").trim();
    if (!normalized) return null;
    const row = this.db.prepare(
      "SELECT id FROM gitverse_installations WHERE lower(login) = lower(?) ORDER BY updated_at DESC LIMIT 1"
    ).get(normalized);
    return row ? this.getInstallation(row.id) : null;
  }

  getRepositoryByFullName(fullName) {
    const repository = repositoryIdentity(fullName);
    const row = this.db.prepare(
      "SELECT repository_id FROM gitverse_repositories WHERE full_name = ? AND active = 1 LIMIT 1"
    ).get(repository);
    return row ? this.getRepository(row.repository_id) : null;
  }

  updateTokens(id, { accessToken, refreshToken, tokenExpiresAt }) {
    if (!accessToken || !refreshToken || !Number.isSafeInteger(tokenExpiresAt) || tokenExpiresAt <= this.clock()) {
      throw new Error("invalid refreshed GitVerse OAuth tokens");
    }
    if (!this.getInstallation(id)) throw Object.assign(new Error("GitVerse installation not found"), { status: 401 });
    this.db.prepare(`
      UPDATE gitverse_installations
      SET access_token_cipher = ?, refresh_token_cipher = ?, token_expires_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      this.encrypt(accessToken, `installation:${id}:access`),
      this.encrypt(refreshToken, `installation:${id}:refresh`),
      tokenExpiresAt,
      this.clock(),
      String(id)
    );
    return this.getInstallation(id);
  }

  createSession(installationId, { ttlMs = 60 * 60 * 1000 } = {}) {
    if (!this.getInstallation(installationId)) throw new Error("GitVerse installation not found");
    this.prune();
    const token = crypto.randomBytes(32).toString("base64url");
    this.db.prepare("INSERT INTO gitverse_sessions (token_hash, installation_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(hash(token), String(installationId), this.clock() + ttlMs, this.clock());
    return token;
  }

  getSessionInstallation(sessionToken) {
    this.prune();
    const row = this.db.prepare("SELECT installation_id, expires_at FROM gitverse_sessions WHERE token_hash = ?").get(hash(sessionToken));
    if (!row || row.expires_at <= this.clock()) return null;
    return this.getInstallation(row.installation_id);
  }

  csrfToken(sessionToken) {
    if (!sessionToken) return "";
    return crypto.createHmac("sha256", this.key).update(`csrf:${sessionToken}`).digest("base64url");
  }

  verifyCsrf(sessionToken, supplied) {
    return secureEqual(this.csrfToken(sessionToken), supplied);
  }

  getRepository(repositoryId) {
    const id = positiveId(repositoryId, "GitVerse repository id");
    const row = this.db.prepare("SELECT * FROM gitverse_repositories WHERE repository_id = ? AND active = 1").get(id);
    if (!row) return null;
    return {
      repositoryId: row.repository_id,
      installationId: row.installation_id,
      fullName: row.full_name,
      webhookId: row.webhook_id,
      webhookSecret: this.decrypt(row.webhook_secret_cipher, `repository:${id}:webhook`)
    };
  }

  listRepositories(installationId) {
    return this.db.prepare(
      "SELECT repository_id, full_name, webhook_id FROM gitverse_repositories WHERE installation_id = ? AND active = 1 ORDER BY full_name"
    ).all(String(installationId)).map(row => ({
      repositoryId: row.repository_id,
      fullName: row.full_name,
      webhookId: row.webhook_id
    }));
  }

  upsertRepository({ repositoryId, installationId, fullName, webhookId, webhookSecret }) {
    const id = positiveId(repositoryId, "GitVerse repository id");
    const hook = positiveId(webhookId, "GitVerse webhook id");
    const repository = repositoryIdentity(fullName);
    if (!this.getInstallation(installationId)) throw new Error("GitVerse installation not found");
    if (Buffer.byteLength(String(webhookSecret || "")) < 32) throw new Error("GitVerse webhook secret is too short");
    const now = this.clock();
    this.db.prepare(`
      INSERT INTO gitverse_repositories
        (repository_id, installation_id, full_name, webhook_id, webhook_secret_cipher, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(repository_id) DO UPDATE SET
        installation_id = excluded.installation_id,
        full_name = excluded.full_name,
        webhook_id = excluded.webhook_id,
        webhook_secret_cipher = excluded.webhook_secret_cipher,
        active = 1,
        updated_at = excluded.updated_at
    `).run(
      id, String(installationId), repository, hook,
      this.encrypt(webhookSecret, `repository:${id}:webhook`),
      now, now
    );
    return this.getRepository(id);
  }

  deleteRepository(repositoryId) {
    this.db.prepare("DELETE FROM gitverse_repositories WHERE repository_id = ?").run(positiveId(repositoryId, "GitVerse repository id"));
  }

  deleteInstallation(installationId) {
    this.db.prepare("DELETE FROM gitverse_installations WHERE id = ?").run(String(installationId));
  }
}
