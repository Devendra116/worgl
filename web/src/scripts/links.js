// Links that leave this site open in a new tab. Links inside the site stay in the same tab.
// Runs once at load and again whenever the page adds or changes a link (the contract and DAO
// addresses are filled in after the chain answers).
function applyExternalLinks() {
  for (const a of document.querySelectorAll("a[href]")) {
    let url;
    try { url = new URL(a.getAttribute("href"), location.href); } catch { continue; }
    if (!/^https?:$/.test(url.protocol) || url.origin === location.origin) continue;
    if (a.target !== "_blank") a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
}
applyExternalLinks();
new MutationObserver(applyExternalLinks).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["href"] });
