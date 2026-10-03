import { GitLabClient } from "./gitlab.mjs";
import { GitVerseClient } from "./gitverse.mjs";

// Read-only connection verification. A successful configuration check is NOT a code review.
// Only installation records belonging to the authenticated session are inspected.
export function providerPaths(provider) {
  if (provider !== 'gitlab' && provider !== 'gitverse') throw new Error('Unsupported provider');
  return {
    name: provider === 'gitlab' ? 'GitLab' : 'GitVerse',
    manage: provider === 'gitlab' ? '/gitlab/projects' : '/gitverse/repositories',
    connected: `/${provider}/connected`,
    connect: `/connect/${provider}`
  };
}

export function projectUrl(base, fullName) {
  const origin = new URL(base);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error('Unsafe provider base URL');
  }
  const parts = String(fullName).split('/');
  if (parts.length < 2 || parts.some(part => !part || part === '.' || part === '..' || /[\\\s\u0000-\u001f]/.test(part))) {
    throw new Error('Unsafe repository path');
  }
  return `${origin.href.replace(/\/$/, '')}/${parts.map(encodeURIComponent).join('/')}`;
}

export function sessionInstallation(service, sessionToken) {
  const installation = service.store.getSessionInstallation(sessionToken);
  if (!installation) throw Object.assign(new Error('Installation session expired'), { status: 401 });
  return installation;
}

export function selectedRecords(provider, service, installationId) {
  providerPaths(provider);
  return provider === 'gitlab'
    ? service.store.listProjects(installationId)
    : service.store.listRepositories(installationId);
}

function verificationError(code, status = 409) {
  return Object.assign(new Error('Connection verification failed'), { code, status });
}

function errorCode(error) {
  const allowed = ['access_denied', 'identity_changed', 'webhook_missing', 'webhook_invalid', 'webhook_disabled'];
  if (allowed.includes(error?.code)) return error.code;
  if ([401, 403, 404].includes(error?.status)) return 'access_denied';
  return 'unavailable';
}

async function bounded(work, signal) {
  signal.throwIfAborted();
  let aborted;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        aborted = () => reject(verificationError('unavailable', 503));
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
      })
    ]);
  } finally {
    if (aborted) signal.removeEventListener('abort', aborted);
  }
}

async function readHook(provider, client, record, signal) {
  if (provider === 'gitlab') {
    try {
      return await client.request(`/projects/${record.projectId}/hooks/${record.webhookId}`, { signal });
    } catch (error) {
      if (error?.status === 404) throw verificationError('webhook_missing');
      throw error;
    }
  }
  const path = record.fullName.split('/').map(encodeURIComponent).join('/');
  // Reuse the provider's supported paginated listing rather than relying on an undocumented detail endpoint.
  for (let page = 1; page <= 10; page += 1) {
    let hooks = await client.request(`/repos/${path}/hooks?page=${page}&per_page=50`, { signal });
    if (Array.isArray(hooks) && hooks.length === 1 && Array.isArray(hooks[0])) hooks = hooks[0];
    if (!Array.isArray(hooks)) throw verificationError('unavailable', 502);
    const found = hooks.find(item => item?.id === record.webhookId);
    if (found) return found;
    if (hooks.length < 50) throw verificationError('webhook_missing');
  }
  throw verificationError('unavailable', 502);
}

export async function verifyConnection({ provider, service, config, sessionToken, timeoutMs = 12_000, clock = Date.now }) {
  providerPaths(provider);
  const installation = sessionInstallation(service, sessionToken);
  const records = selectedRecords(provider, service, installation.id);
  const base = provider === 'gitlab' ? config.gitlabBaseUrl : config.webBaseUrl;
  const items = records.map(record => ({
    id: provider === 'gitlab' ? record.projectId : record.repositoryId,
    name: provider === 'gitlab' ? record.pathWithNamespace : record.fullName,
    url: projectUrl(base, provider === 'gitlab' ? record.pathWithNamespace : record.fullName),
    state: 'pending',
    code: 'unavailable',
    hardGateConfigured: record.hardGateEnabled === true
  }));
  const result = { provider, account: String(installation.username || installation.login || ''), items, state: 'empty', checkedAt: null };
  if (!items.length) return result;
  if (items.length > 1000) throw verificationError('unavailable', 422);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = controller.signal;
  try {
    let client;
    try {
      const authenticated = await bounded(() => provider === 'gitlab'
        ? service.gitlabForInstallation(installation.id)
        : service.gitverseForInstallation(installation.id), signal);
      const fetchImpl = (input, options = {}) => authenticated.fetchImpl(input, { ...options, signal });
      client = provider === 'gitlab'
        ? new GitLabClient({ baseUrl: authenticated.baseUrl, token: authenticated.token, authMode: authenticated.authMode, fetchImpl })
        : new GitVerseClient({ apiBaseUrl: authenticated.apiBaseUrl, token: authenticated.token, fetchImpl });
    } catch (error) {
      const code = errorCode(error);
      for (const item of items) Object.assign(item, { code, state: code === 'unavailable' ? 'pending' : 'attention' });
    }
    if (client) {
      let next = 0;
      async function worker() {
        while (next < records.length) {
          const index = next++;
          const record = records[index];
          const item = items[index];
          try {
            await bounded(async () => {
              if (!Number.isSafeInteger(item.id) || item.id < 1 || !Number.isSafeInteger(record.webhookId) || record.webhookId < 1) {
                throw verificationError('identity_changed');
              }
              const repositoryPath = item.name.split('/').map(encodeURIComponent).join('/');
              const project = await client.request(provider === 'gitlab' ? `/projects/${item.id}` : `/repos/${repositoryPath}`, { signal });
              if (project?.id !== item.id || (provider === 'gitlab' ? project.path_with_namespace : project.full_name) !== item.name) {
                throw verificationError('identity_changed');
              }
              const level = Math.max(Number(project?.permissions?.project_access?.access_level || 0), Number(project?.permissions?.group_access?.access_level || 0));
              if (project.archived === true || project.disabled === true || (provider === 'gitlab' ? level < 40 : project?.permissions?.admin !== true)) {
                throw verificationError('access_denied');
              }
              const hook = await readHook(provider, client, record, signal);
              if (hook?.id !== record.webhookId) throw verificationError('webhook_missing');
              if (provider === 'gitlab') {
                if (hook.url !== config.webhookUrl || hook.merge_requests_events !== true || hook.enable_ssl_verification !== true) {
                  throw verificationError('webhook_invalid');
                }
                if ((hook.alert_status && hook.alert_status !== 'executable') || (hook.disabled_until && (!Number.isFinite(Date.parse(hook.disabled_until)) || Date.parse(hook.disabled_until) > clock()))) {
                  throw verificationError('webhook_disabled');
                }
              } else {
                if (hook?.config?.url !== `${config.webhookUrl}/${item.id}` || (!Array.isArray(hook?.events) || !hook.events.includes('pull_request'))) {
                  throw verificationError('webhook_invalid');
                }
                if (hook.active !== true) throw verificationError('webhook_disabled');
              }
            }, signal);
            Object.assign(item, { state: 'connected', code: 'verified' });
          } catch (error) {
            const code = errorCode(error);
            Object.assign(item, { state: code === 'unavailable' ? 'pending' : 'attention', code });
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, records.length) }, worker));
    }
    result.state = items.every(item => item.state === 'connected') ? 'connected'
      : items.some(item => item.state === 'attention') ? 'attention' : 'pending';
    result.checkedAt = new Date(clock()).toISOString();
    return result;
  } finally {
    clearTimeout(timer);
  }
}
