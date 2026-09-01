# postflop postkit DISCLOSURE

What in this kit is synthetic, and what to declare when you upload it. Read this
before distribution, the same way you read LICENCES.md.

## What this pipeline actually synthesised

- **Voiceover** — synthetic speech (7 line(s), text-to-speech). This is a synthetic VOICE and is disclosable on every platform below.
- **Music bed** — generated track. Disclosable as synthetic audio.
- **Motion graphics / titles / mark animation** — rendered programmatically from brand tokens (Remotion). Not "AI-generated imagery": no generative image model produced these frames, so a blanket AI label would be inaccurate.
- **Product footage** — a real screen recording of the real application. Genuine capture, not synthetic. Do not label it as generated.

## At upload: declare it yourself

Tick the platform's own AI-content toggle **before** publishing.
Proactive disclosure costs close to nothing in reach. An undisclosed asset caught
by platform detection instead gets a distribution hold applied while the label is
applied retroactively, and that hold lands during the early-engagement window that
decides how far the post travels. The cost is in being caught, not in disclosing.

- TikTok — "AI-generated content" toggle at upload.
- YouTube — "Altered or synthetic content" disclosure in the upload flow.
- Instagram / Facebook — "AI info" labelling in the composer.
- LinkedIn / X — no mandatory toggle today; say so in the copy if the voice is synthetic.

## Known gaps in this kit

- **No C2PA credential is embedded.** EU AI Act Article 50 has required
  machine-readable synthetic-content disclosure for EU-facing content since
  2026-08-02, and the files in this kit carry no cryptographic provenance
  manifest. Platform self-declaration above is a human step, not a
  machine-readable one. Closing this needs `c2patool` and a signing certificate.
- **If you automate posting to TikTok**, note that its Content Posting API
  publishes every video as private-only until the app passes TikTok's audit. An
  unaudited integration succeeds at every API call and reaches nobody.
