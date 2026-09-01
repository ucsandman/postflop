# postflop marketing assets

Rendered 2026-09-01 by the marketing-studio engine (C:/Projects/animations, brand
`postflop`, direction "The Proof Sheet"). Every number in the copy traces to a
proof point in the approved brief. Voiceover and music are synthetic; product
footage is a real screen recording of the workbench at commit 2245821.

| File | What it is | Use |
| --- | --- | --- |
| `launch.mp4` | 77s launch film, 1920x1080, VO + music, mastered to -14 LUFS | Hero video on the landing page, YouTube, LinkedIn native upload |
| `logo-reveal.mp4` | 3s spade + wordmark reveal | Video intros, stings |
| `social-x.mp4` | 10s clip: hook headline, convergence plate, CTA block; music bed plus the hook VO line, -14 LUFS | X post attachment (or use `postkit/x/`). VO is text-to-speech: disclose in copy |
| `social-linkedin.mp4` | 10s clip: "Convergence is measured, never asserted.", node-lock plate, CTA; music bed plus the node-lock VO line | LinkedIn post attachment (or use `postkit/linkedin/`). VO is text-to-speech: disclose in copy |
| `og.png` | 1200x630 link-preview image | `og:image` and `twitter:image` |
| `og.mp4` | 8s seamless 1200x630 loop | Animated hero or social embed where video previews are supported |
| `readme.gif` | 600x315 loop, 3 MB | GitHub README |
| `captions/launch.srt`, `launch.vtt` | VO captions, 7 cues | Upload alongside `launch.mp4` on YouTube and LinkedIn |
| `thumbs/thumb-*.jpg` | Poster stills per aspect (16:9, 1:1, 4:5, 9:16) | Video thumbnails |
| `cards/` | 18 stills: one stat card per proof point (1080x1080 and 1080x1350) plus the hook quote card | Image posts, carousel slides |
| `postkit/<platform>/` | Paste-ready kit per platform: right-aspect video, thumbnail, `caption.txt`, `alt.txt`, `POST.md` checklist | Publishing. Read `postkit/DISCLOSURE.md` first: the VO is synthetic and should be declared where a platform asks |

Posting notes for X are in `../../../docs/x-launch-drafts.md`. Put links in the
first reply, not the post body. The launch VO is text-to-speech; say so in copy
on platforms without an AI toggle.

Not copied here: the raw 16:9 / 1:1 / 4:5 / 9:16 export matrix (the postkit
carries the per-platform copies) and `og.gif` (6 MB; prefer `og.mp4`). Both live
in the engine repo under `out/postflop/`.
