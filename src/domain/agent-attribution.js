export function matchesSessionBinding(session, binding, { versionOffset = 0 } = {}) {
  return session?.sessionId === binding?.sessionId
    && session?.version === binding?.version + versionOffset
    && session?.externalSessionId === binding?.externalSessionId
    && session?.externalLocator === binding?.externalLocator;
}

export function matchesSessionTurnIdentity(actual, expected) {
  return actual?.sessionId === expected?.sessionId
    && actual?.turnId === expected?.turnId;
}
