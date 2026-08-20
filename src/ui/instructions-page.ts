/**
 * Shows the agent brief so it can be copied straight into a chat window.
 *
 * Fetched from GET /api/brief rather than bundled, so what you paste is exactly
 * what the API serves and cannot drift from it.
 */
import { escapeHtml } from './changelog-view.js';

const content = document.getElementById('content')!;
/**
 * The address to hand a model is the one this page was reached on, not a
 * hardcoded port. Every API route lives under /api, and in development Vite
 * proxies /api through to the server, so this is correct whether the page came
 * from the dev server or from the single-port production process.
 */
const apiBase = `${location.origin}/api`;

async function load(): Promise<void> {
  let brief: string;
  try {
    const response = await fetch('/api/brief');
    if (!response.ok) throw new Error(`the API responded ${response.status}`);
    brief = await response.text();
  } catch (error) {
    content.innerHTML = `
      <h1>Instructions for an LLM</h1>
      <p class="provenance">Could not reach the API: ${escapeHtml(error instanceof Error ? error.message : String(error))}.
      Start it with <code>npm run dev</code> and reload.</p>`;
    return;
  }

  content.innerHTML = `
    <h1>Instructions for an LLM</h1>
    <p class="provenance">
      Paste everything below into the model you want writing strategies, then tell it the API is at
      <code>${escapeHtml(apiBase)}</code>. That is the address this page was served from, so it is the one that
      works. This is the live response from <code>GET /api/brief</code>, so it cannot fall out of step with the
      simulation, and a model with network access to that address can fetch it itself instead.
    </p>
    <p><button id="copy" class="primary">Copy the brief</button> <span id="copied" class="provenance"></span></p>
    <pre id="brief"></pre>`;

  (document.getElementById('brief') as HTMLPreElement).textContent = brief;

  document.getElementById('copy')!.addEventListener('click', async () => {
    const note = document.getElementById('copied')!;
    try {
      await navigator.clipboard.writeText(brief);
      note.textContent = `copied ${brief.length} characters`;
    } catch {
      // Clipboard access can be refused, so say so rather than appearing to work.
      note.textContent = 'clipboard refused, select the text below instead';
    }
  });
}

void load();
