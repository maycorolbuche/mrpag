const statusUrl = window.location.pathname + '/status';
const pollInterval = 5000;
let timer;
let checking = false;
let finished = false;

function schedule() {
  clearTimeout(timer);
  if (!document.hidden && !finished) timer = setTimeout(checkStatus, pollInterval);
}

async function checkStatus() {
  if (checking || finished || document.hidden) return;
  checking = true;
  try {
    const response = await fetch(statusUrl, {
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(pollInterval),
    });
    if (response.status === 404 || (response.ok && (await response.json()).status !== 'pending')) {
      finished = true;
      window.location.reload();
    }
  } catch {
    // Keep the current page available and retry on the next cycle.
  } finally {
    checking = false;
    schedule();
  }
}

document.addEventListener('visibilitychange', () => {
  clearTimeout(timer);
  if (!document.hidden) checkStatus();
});
schedule();
