import { showDashboardPageError } from "./dashboard-status-view.js";

// Install the failure surface before importing the application and its modules.
window.addEventListener("error", event => showDashboardPageError(event.error ?? new Error("Dashboard script failed.")));
window.addEventListener("unhandledrejection", event => showDashboardPageError(event.reason));
document.addEventListener("submit", event => {
  if (!document.getElementById("dashboardPageError").hidden) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
document.getElementById("dashboardAddress").textContent = window.location.origin;
document.getElementById("refreshDashboard").onclick = () => window.location.reload();
try {
  await import("./app.js");
  const projects = document.getElementById("toggleProjectNavigation");
  projects.addEventListener("click", () => {
    const expanded = projects.getAttribute("aria-expanded") !== "true";
    projects.setAttribute("aria-expanded", String(expanded));
    projects.textContent = expanded ? "프로젝트 닫기" : "프로젝트 보기";
  });
  if (document.getElementById("dashboardPageError").hidden) document.getElementById("refreshDashboard").onclick = null;
} catch (error) {
  showDashboardPageError(error);
}
