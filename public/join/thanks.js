// Shows where the tracker is, if the server knows.
(async () => {
  try {
    const { trackerUrl } = await (await fetch('/api/offer')).json();
    if (typeof trackerUrl === 'string' && new URL(trackerUrl).protocol === 'https:') {
      document.getElementById('tracker-link').href = trackerUrl;
      document.getElementById('tracker-link').textContent = new URL(trackerUrl).host;
      document.getElementById('tracker').hidden = false;
    }
  } catch { /* the page reads fine without it */ }
})();
