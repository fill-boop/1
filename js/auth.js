// "Sign in with Hugging Face" for a static site (OAuth authorization code + PKCE).
// The visitor's token stays in their own browser and is sent only to
// huggingface.co and the .hf.space model servers.
import { HF_CLIENT_ID, HF_SCOPES } from "./config.js";

const HF = "https://huggingface.co";
const KEY = "vgen.hfauth";
const PENDING = "vgen.hfauth.pending";

export const authEnabled = () => !!HF_CLIENT_ID;
const redirectUri = () => `${location.origin}/`;

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomString(n = 48) {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}

export async function login() {
  const verifier = randomString(48);
  const state = randomString(16);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  sessionStorage.setItem(PENDING, JSON.stringify({ verifier, state }));
  const q = new URLSearchParams({
    client_id: HF_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: HF_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  location.assign(`${HF}/oauth/authorize?${q}`);
}

export function logout() {
  try { localStorage.removeItem(KEY); } catch {}
}

// Call once on page load. Finishes a login if we just came back from huggingface.co.
// Returns an error message string, or null.
export async function handleRedirect() {
  const params = new URLSearchParams(location.search);
  if (!params.has("code") && !params.has("error")) return null;
  const clean = () => history.replaceState(null, "", location.pathname);
  let pending = null;
  try { pending = JSON.parse(sessionStorage.getItem(PENDING) || "null"); } catch {}
  sessionStorage.removeItem(PENDING);

  if (params.has("error")) { clean(); return `Sign-in cancelled (${params.get("error")}).`; }
  if (!pending || pending.state !== params.get("state")) { clean(); return "Sign-in failed: the response didn't match this browser. Please try again."; }

  try {
    const r = await fetch(`${HF}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: params.get("code"),
        redirect_uri: redirectUri(),
        client_id: HF_CLIENT_ID,
        code_verifier: pending.verifier,
      }),
    });
    const tok = await r.json();
    if (!r.ok || !tok.access_token) throw new Error(tok.error_description || tok.error || `HTTP ${r.status}`);
    let user = {};
    try {
      const u = await fetch(`${HF}/oauth/userinfo`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
      if (u.ok) user = await u.json();
    } catch {}
    localStorage.setItem(KEY, JSON.stringify({
      token: tok.access_token,
      expiresAt: Date.now() + (tok.expires_in || 3600) * 1000,
      name: user.preferred_username || user.name || "Hugging Face user",
      avatar: user.picture || null,
      isPro: !!user.isPro,
    }));
    clean();
    return null;
  } catch (e) {
    clean();
    return `Sign-in failed: ${e.message}`;
  }
}

// The signed-in visitor, or null. Expired logins count as signed out.
export function currentUser() {
  let a = null;
  try { a = JSON.parse(localStorage.getItem(KEY) || "null"); } catch {}
  if (!a || Date.now() > a.expiresAt - 60000) return null;
  return a;
}
