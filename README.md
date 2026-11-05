# Video Studio (prototype)

One page that sends text, image or video prompts to free Hugging Face video Spaces (Wan 2.2, LTX).
Everything runs in the visitor's browser, so each visitor uses their **own** free ZeroGPU allowance
(about 2 GPU minutes a day when not logged in to Hugging Face).

## Run it

```bash
python -m http.server 8080 --bind 127.0.0.1
```

Then open http://localhost:8080. Any static host works (no server code).

## Files

- `index.html`, `styles.css`: the page
- `js/models.js`: model list, backup Spaces, per-model fixes. **Add or remove models here.**
- `js/gradio.js`: browser-side Gradio client (upload, queue, live progress, error types)
- `js/app.js`: builds the form from each Space's own config, runs the job, retries and switches

## What it handles

- The form is built from each Space's live config, so all its options appear, with the Space's own ranges and defaults.
- "No GPU was available after 60s": stops and tells the visitor. No automatic retry, because testing showed that wait still uses up the visitor's free GPU time, and every ZeroGPU Space shares one GPU pool.
- Space busy (other errors) or a dropped connection: waits 5 seconds and retries once, then tries the model's backup Spaces, then other models (if the checkbox is on).
- Quota refused as "Xs requested vs Ys left": tries lighter models that may fit in what's left, then stops.
- Space down or paused: skipped. Status is checked on page load.
- Page reload mid-job: the inputs, including files, are saved in the browser and the job restarts automatically. Gradio cancels a job when its page goes away, so it can't be rejoined.
- Daily quota used up: stops and explains. Switching models doesn't help, because the quota is shared across all ZeroGPU Spaces.

## Sign in with Hugging Face

Signed-in visitors use their own Hugging Face quota: 5 min/day free, 40 min/day for PRO, with better queue priority.

1. Create an OAuth app in your Hugging Face settings, **without a client secret** (a public app).
   - Redirect URIs: `https://video-studio-ecru.vercel.app/` and `http://localhost/` (any local port is allowed).
   - Scopes: `openid`, `profile`.
2. Put its Client ID in `js/config.js` (`HF_CLIENT_ID`). It's public, not a secret.
3. Commit and push. The button appears once the ID is set.

The token stays in the visitor's browser and is only sent to huggingface.co and the `.hf.space` Spaces.

## Known limits

- Anonymous visitors have the lowest queue priority. In testing (Nov 2026), every anonymous attempt got "No GPU was available after 60s", and 2 minutes of free time were used up without producing a video.
- Spaces reserve more time than a video needs (LTX-2.3: 112s, ltx-video-distilled: 120s, LTX First+Last: 150s). The quota check uses the reserved time, so an anonymous visitor's 120 s doesn't cover even one of those.
- Result links on the Spaces are temporary. Users should download right away.
- Backup Spaces are other people's copies. Their component ids can differ, so ltx-2-TURBO's hidden duration field may not carry over to its backups.
