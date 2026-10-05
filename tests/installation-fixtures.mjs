import { createGitLabSelfService } from '../src/gitlab-self-service.mjs';
import { createGitVerseSelfService } from '../src/gitverse-self-service.mjs';

export function installationFixture(provider, { installed = true, username = 'alice', count = 1, baseUrl } = {}) {
  const now = Date.now();
  const base = baseUrl || (provider === 'gitlab' ? 'https://gitlab.com' : 'https://gitverse.ru');
  const config = {
    gitlabBaseUrl: base, webBaseUrl: base, apiBaseUrl: 'https://api.gitverse.ru',
    oauthClientId: 'test-client', oauthClientSecret: 'NEVER-EXPOSE-client-secret',
    oauthRedirectUri: `https://reviewer.example.com/oauth/${provider}/callback`,
    webhookUrl: `https://reviewer.example.com/webhooks/${provider}`,
    installationsDb: ':memory:', tokenEncryptionKey: 'test-encryption-key-at-least-32-bytes',
    oauthStateTtlMs: 600000, installSessionTtlMs: 3600000, maxDiscoverProjects: 100,
    maxDiscoverRepositories: 100, maxInstallProjects: 100, maxInstallRepositories: 100,
    reviewerApiUrl: 'https://engine.example.com', reviewerApiToken: 'NEVER-EXPOSE-engine-token', reviewTimeoutMs: 1000
  };
  const calls = [];
  const projects = Array.from({ length: count }, (_, index) => ({
    id: 7 + index, name: 'Widget', path_with_namespace: `${username}/widget${index || ''}`,
    full_name: `${username}/widget${index || ''}`, default_branch: 'main', visibility: 'private',
    permissions: { project_access: { access_level: 40 }, admin: true }
  }));
  const hooks = new Map();
  const mode = { httpStatus: 200, neverRespond: false, wrongIdentity: false };
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, method: options.method || 'GET', signal: options.signal });
    if (mode.neverRespond) return new Promise((_, reject) => {
      if (options.signal?.aborted) reject(options.signal.reason);
      options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
    if (mode.httpStatus !== 200) return Response.json({ message: 'NEVER-EXPOSE-provider-error-token' }, { status: mode.httpStatus });
    if (url.hostname === 'engine.example.com') return Response.json({ created: false, entitlement: { id: 'test-license', plan: 'starter' } });
    if (url.pathname === '/oauth/token') return Response.json({ access_token: 'NEVER-EXPOSE-access', refresh_token: 'NEVER-EXPOSE-refresh', expires_in: 3600, created_at: Math.floor(Date.now() / 1000) });
    if (url.pathname.endsWith('/user')) return Response.json({ id: 42, username, login: username });
    if (url.pathname.endsWith('/projects') || url.pathname === '/user/repos') return Response.json(projects);
    for (const project of projects) {
      const path = provider === 'gitlab' ? `/api/v4/projects/${project.id}` : `/repos/${project.full_name}`;
      if (url.pathname === path) return Response.json(mode.wrongIdentity ? { ...project, id: 999 } : project);
      const hookPath = `${path}/hooks`;
      if (url.pathname === hookPath && options.method === 'GET') return Response.json(hooks.has(project.id) ? [hooks.get(project.id)] : []);
      if (url.pathname === `${hookPath}/${project.id + 80}` && options.method === 'GET') {
        return hooks.has(project.id) ? Response.json(hooks.get(project.id)) : Response.json({}, { status: 404 });
      }
      if (url.pathname.startsWith(hookPath) && ['POST', 'PUT', 'PATCH'].includes(options.method)) {
        const body = JSON.parse(options.body);
        const hook = { ...body, id: project.id + 80, alert_status: 'executable' };
        hooks.set(project.id, hook);
        return Response.json(hook);
      }
      if (url.pathname === `${hookPath}/${project.id + 80}` && options.method === 'DELETE') {
        hooks.delete(project.id);
        return new Response(null, { status: 204 });
      }
    }
    throw new Error(`Unexpected fixture call: ${options.method} ${url.pathname}`);
  };
  const service = (provider === 'gitlab' ? createGitLabSelfService : createGitVerseSelfService)({ config, fetchImpl });
  const installation = service.store.upsertInstallation({ baseUrl: base, userId: 42, username, login: username,
    accessToken: 'NEVER-EXPOSE-access', refreshToken: 'NEVER-EXPOSE-refresh', tokenExpiresAt: now + 3600000 });
  const sessionToken = service.store.createSession(installation.id);
  if (installed) {
    for (const project of projects) {
      const webhookId = project.id + 80;
      const common = { installationId: installation.id, webhookId, webhookSecret: 'NEVER-EXPOSE-webhook-secret-at-least-32-bytes' };
      if (provider === 'gitlab') {
        service.store.upsertProject({ ...common, projectId: project.id, pathWithNamespace: project.path_with_namespace });
        hooks.set(project.id, { id: webhookId, url: config.webhookUrl, merge_requests_events: true, enable_ssl_verification: true, alert_status: 'executable', disabled_until: null });
      } else {
        service.store.upsertRepository({ ...common, repositoryId: project.id, fullName: project.full_name });
        hooks.set(project.id, { id: webhookId, config: { url: `${config.webhookUrl}/${project.id}` }, active: true, events: ['pull_request'] });
      }
    }
  }
  return { provider, service, config, sessionToken, installation, projects, hooks, calls, mode,
    csrf: service.store.csrfToken(sessionToken), cookie: `peerivo_${provider}_install=${sessionToken}` };
}
