export async function createConversationBootstrapTab(chromeApi, waitForContentScript) {
  let created;
  try {
    created = await chromeApi.tabs.create({ url:"https://chatgpt.com/", active:false });
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(created?.id)) return null;
  await waitForContentScript(created.id, 30_000, true);
  return chromeApi.tabs.get(created.id);
}
