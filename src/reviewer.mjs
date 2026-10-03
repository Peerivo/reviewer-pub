// Preserve the bounded collectors unchanged. This facade attaches the owner from
// the SAME authoritative metadata read, adding no provider calls or source reads.
export * from "./reviewer-core.mjs";
import * as core from "./reviewer-core.mjs";
import { licenseOwner } from "./license-owner.mjs";

async function collectWithOwner(options, { clientName, method, metadata, apiBase, collect }) {
  const client = options[clientName];
  let owner;
  const provider = new Proxy(client, {
    get(target, property) {
      if (property === method) return async (...args) => {
        const result = await target[method](...args);
        owner = licenseOwner(clientName, metadata(result), apiBase(client));
        return result;
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const result = await collect({ ...options, [clientName]: provider });
  return owner ? { ...result, licenseOwner: owner } : result;
}

export function collectReviewPayload(options) {
  return collectWithOwner(options, { clientName: "github", method: "pullRequest",
    metadata: pr => pr?.base?.repo, apiBase: () => "https://api.github.com", collect: core.collectReviewPayload });
}
export function collectGitLabReviewPayload(options) {
  return collectWithOwner(options, { clientName: "gitlab", method: "project",
    metadata: project => project, apiBase: client => client.apiBase, collect: core.collectGitLabReviewPayload });
}
export function collectGitVerseReviewPayload(options) {
  return collectWithOwner(options, { clientName: "gitverse", method: "repository",
    metadata: repository => repository, apiBase: client => client.apiBaseUrl, collect: core.collectGitVerseReviewPayload });
}
