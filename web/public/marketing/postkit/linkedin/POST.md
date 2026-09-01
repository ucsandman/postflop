# postflop — LinkedIn post kit

## Files
- Video: launch-16x9.mp4
- Silent cut: launch-16x9-silent.mp4 (muted-autoplay embeds)
- Thumbnail: thumb.jpg
- Caption: caption.txt (paste as the post copy)
- Alt text: alt.txt (one-sentence video description)
- Captions: launch.srt, launch.vtt (upload alongside the video)

## Before you publish
1. No mandatory AI toggle on LinkedIn today — if the voiceover is synthetic, say so in the copy (see DISCLOSURE.md at the kit root).
2. Destination link: https://postflop.vercel.app?utm_source=linkedin&utm_medium=video&utm_campaign=postflop
3. After publishing, paste the live post URL into out/postflop/marketing/posts.json's `url` field for this platform (and set `published` to true).

## Notes
Upload the video natively to LinkedIn (native video outperforms a link post). Paste caption.txt as the post body.
