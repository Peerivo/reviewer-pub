// Called only with authenticated provider API responses, never form/webhook data.
export function licenseOwner(platform, metadata, apiBase) {
  const entity = platform === "gitlab" ? metadata?.namespace : metadata?.owner;
  if (!Number.isSafeInteger(entity?.id) || entity.id < 1) return undefined;
  let instance;
  try {
    const url = new URL(apiBase);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    instance = url.origin;
  } catch { return undefined; }
  return { id: entity.id, instance };
}

export function ownerKey(owner) {
  return owner ? `${owner.instance}:${owner.id}` : "";
}
