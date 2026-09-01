# postflop — YouTube post kit

## Files
- Video: launch-16x9.mp4
- Silent cut: launch-16x9-silent.mp4 (muted-autoplay embeds)
- Thumbnail: thumb.jpg
- Caption: caption.txt (paste as the post copy)
- Alt text: alt.txt (one-sentence video description)
- Captions: launch.srt, launch.vtt (upload alongside the video)

## Before you publish
1. Set the "Altered or synthetic content" disclosure before publishing if this cut has synthetic voiceover or music (see DISCLOSURE.md at the kit root).
2. Destination link: https://postflop.vercel.app?utm_source=youtube&utm_medium=video&utm_campaign=postflop
3. After publishing, paste the live post URL into out/postflop/marketing/posts.json's `url` field for this platform (and set `published` to true).

## Notes
Upload as a standard YouTube video. Paste caption.txt as the description, then upload launch.srt or launch.vtt as captions in YouTube Studio.
