# postflop on X: launch drafts

Drafted 2026-09-01 against the council-approved brief. Every number traces to a
proofPoint in the brief. Post from the Premium account. Attach the native video
(the X clip from the postkit once it lands, or launch-final.mp4 trimmed to the hook).
Link goes in the FIRST REPLY, never the post body.

## What the research says (short version)

From the open-sourced ranker (github.com/xai-org/x-algorithm, Aug 2026): the score
is a weighted sum of predicted actions. Positives it names: reply, repost, quote,
share, profile click, video quality view, dwell, follow. Negatives: not interested,
mute, block, report, not dwelled. The weights themselves were withheld, so every
"27x / 150x" number online is folklore. What is measured: Buffer's 18.8M-post study
puts a non-Premium account's median under 100 impressions per post and Premium
over 600. Video autoplays muted, so the first two seconds have to read with no sound.

Practical: one native video, hook in the first line, link in reply one, then stay
on the post for an hour and answer everyone. Replies and quotes are what the code
scores. Posting time and hashtag effects are unverified either way, so skip hashtags
and post when you can actually be there to reply.

## Option A: single post plus link reply (fastest)

Post:

Your solver is grading its own homework.

I built postflop, an open source heads up NLHE solver in Rust. Instead of telling you it converged, a separate best response calculator measures exploitability at every report and prints it. Chips, % of pot, tagged [measured].

Same engine runs in the browser. Nothing to install.

First reply (your own, right after posting):

Solve a spot in the browser, no signup: https://postflop.vercel.app?utm_source=x&utm_medium=video&utm_campaign=postflop
Source, MIT: https://github.com/ucsandman/postflop

Attach: web/public/marketing/postkit/x/social-16x9.mp4 (10s, silent, no disclosure
needed). If you attach the launch film instead (VO is text-to-speech), add one line
such as "Narration is TTS." per postkit/DISCLOSURE.md.

## Option B: three-post thread (more room for receipts)

1/

Your solver is grading its own homework.

I built postflop, an open source heads up NLHE solver in Rust. Instead of telling you it converged, a separate best response calculator measures exploitability at every report and prints it. Chips, % of pot, tagged [measured].

Same engine runs in the browser. Nothing to install.

2/

The numbers, with the harnesses committed so you can rerun them:

77M hand evals per second on a 10M hand pool
Evaluator checked against a slow oracle on all 2,598,960 five card hands
All 22,100 flops collapse to 1,755 canonical classes, verified over every one
A 1,881 node turn spot solves to 0.12% of pot in 0.2s
Bit identical output from 1 to 24 threads

3/

Node locking is in (villain never bluffs this river, solve around it). Ranges parse in PioSOLVER format. Solve big trees with the CLI, open the same file in the browser.

If you use Pio or GTO Wizard, tell me what's missing.

Try it: https://postflop.vercel.app
Source, MIT: https://github.com/ucsandman/postflop

## First hour

Answer every reply, even the one word ones. A skeptic asking "how is exploitability
measured" is the best thing that can happen to this post: the answer (best response
calculator separate from the solve, MIT source you can read) is the whole pitch.
Do not ask for likes or reposts. Quote-repost your own post the next day with one
new receipt (a screenshot of a real solve) instead of reposting it bare.
