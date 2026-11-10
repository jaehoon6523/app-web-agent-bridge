# Browser workflow

- For browser-related work in this project, use the Codex app's in-app browser by default. Treat “the browser” as the in-app browser unless the user explicitly says otherwise.
- Do not switch to Windows Chrome or Computer Use by default. Use native Chrome only when the task specifically requires its profile, extension runtime, or DevTools, or when the user explicitly requests it.
- For the local dashboard, open `http://127.0.0.1:8787/` in the in-app browser. Do not infer that the server is running; check the page response in that browser.
