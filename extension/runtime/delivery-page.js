export async function readDeliveryPage(tabs, tabId) {
  if (!Number.isSafeInteger(tabId)) return null;
  let timer;
  try {
    return await Promise.race([tabs.sendMessage(tabId, { type: "agent.ping" }, { frameId: 0 }),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 2000); })]);
  } catch { return null; }
  finally { clearTimeout(timer); }
}
