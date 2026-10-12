# Synthesize caller lines for scripts/voice_call.ts: one raw 16 kHz mono s16le PCM file per line.
# Uses Google TTS over HTTPS (gTTS) and ffmpeg. Run with python3 -I; prints the written paths.
#   python3 -I scripts/voice_tts.py <out_dir> "<line 1>" "<line 2>" ...
import os
import subprocess
import sys

from gtts import gTTS

out_dir = sys.argv[1]
os.makedirs(out_dir, exist_ok=True)
for i, text in enumerate(sys.argv[2:]):
    mp3 = os.path.join(out_dir, f"line{i}.mp3")
    raw = os.path.join(out_dir, f"line{i}.pcm")
    if not os.path.exists(raw):
        gTTS(text, lang="en", tld="us").save(mp3)
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", mp3, "-ar", "16000", "-ac", "1", "-f", "s16le", raw],
            check=True,
        )
    print(raw)
