"""Maps the performance DSL to EchoMimicV3 conditioning.

EchoMimicV3 is audio + reference-image + *text-prompt* driven: lip/expression
motion comes from the audio (wav2vec2) and the still reference, while the text
prompt steers gesture / posture / scene. There is a single prompt per pipeline
call, so the per-segment DSL beats are first turned into per-window prompts
(kept with their timing for documentation / future per-chunk prompting) and then
summarised into one natural-language prompt that describes the dominant
performance of the whole clip plus an audio-CFG strength hint.

  emotion           -> facial expression words + expression intensity
  gesture / posture -> motion / body text prompt
  emphasis          -> spoken-emphasis cue (mostly prosodic, light visual hint)
  timings           -> per-window start/end so motion aligns to speech
"""

from __future__ import annotations

from collections import Counter

EMOTION_PROMPT = {
    "neutral": "a calm neutral expression",
    "warm": "a warm friendly expression",
    "happy": "a happy smiling expression",
    "excited": "an excited energetic expression",
    "serious": "a serious focused expression",
    "concerned": "a concerned expression",
    "sad": "a subdued sad expression",
    "confident": "a confident assured expression",
    "thoughtful": "a thoughtful reflective expression",
    "surprised": "a surprised expression",
}

GESTURE_PROMPT = {
    "none": "natural subtle movement",
    "wave": "waving a hand in greeting",
    "point": "pointing forward to emphasize a point",
    "open_palms": "open palms in a welcoming gesture",
    "count": "counting on fingers",
    "thumbs_up": "a thumbs up of approval",
    "nod": "nodding in agreement",
    "shrug": "shrugging the shoulders",
    "hand_to_chest": "a hand to the chest, sincere",
    "explain": "explanatory hand movements",
}

POSTURE_PROMPT = {
    "neutral": "an upright neutral posture",
    "leaning_in": "leaning slightly toward the camera, engaged",
    "upright": "a confident upright posture",
    "relaxed": "relaxed shoulders, casual",
    "turned_slightly": "the body turned slightly to one side",
}

# Expression strength per emotion, used to nudge the audio guidance scale: more
# expressive beats get a slightly stronger audio CFG so lips/face track harder.
EMOTION_INTENSITY = {
    "neutral": 0.2,
    "warm": 0.5,
    "happy": 0.7,
    "excited": 0.9,
    "serious": 0.4,
    "concerned": 0.5,
    "sad": 0.6,
    "confident": 0.6,
    "thoughtful": 0.4,
    "surprised": 0.8,
}


def segment_prompt(emotion: str, gesture: str, posture: str, emphasis: list[str] | None = None) -> str:
    parts = [
        f"A person speaking to camera with {EMOTION_PROMPT.get(emotion, EMOTION_PROMPT['neutral'])}",
        GESTURE_PROMPT.get(gesture, GESTURE_PROMPT["none"]),
        POSTURE_PROMPT.get(posture, POSTURE_PROMPT["neutral"]),
    ]
    prompt = ", ".join(parts)
    if emphasis:
        prompt += f", emphasizing \"{' '.join(emphasis[:4])}\""
    return prompt + "."


def build_conditioning(timings: list[dict]) -> list[dict]:
    """Per-window motion conditioning: a natural-language prompt + timing.

    Each input timing carries emotion/gesture/posture (from the voice stage) and
    may carry `emphasis` (joined in from the script by `seq`). The output keeps
    timing so a future per-chunk prompting path can switch prompts mid-clip; the
    current adapter renders one clip with the summarised prompt below.
    """
    windows = []
    for t in timings:
        emotion = t.get("emotion", "neutral")
        gesture = t.get("gesture", "none")
        posture = t.get("posture", "neutral")
        emphasis = t.get("emphasis", []) or []
        windows.append(
            {
                "seq": t.get("seq", 0),
                "start_s": t.get("start_s", 0.0),
                "end_s": t.get("end_s", 0.0),
                "emotion": emotion,
                "gesture": gesture,
                "posture": posture,
                "emphasis": emphasis,
                "prompt": segment_prompt(emotion, gesture, posture, emphasis),
                "expression_intensity": EMOTION_INTENSITY.get(emotion, 0.4),
            }
        )
    return windows


def _dominant(values: list[str], fallback: str) -> str:
    if not values:
        return fallback
    return Counter(values).most_common(1)[0][0]


def summarize_performance(conditioning: list[dict]) -> dict:
    """Collapse per-window conditioning into one clip-level EchoMimicV3 prompt.

    EchoMimicV3 takes a single text prompt per generation, so we describe the
    dominant emotion/posture plus the distinct gestures that occur, and report a
    mean expression intensity used to scale audio guidance.
    """
    if not conditioning:
        return {
            "prompt": segment_prompt("neutral", "none", "neutral"),
            "expression_intensity": EMOTION_INTENSITY["neutral"],
        }

    emotions = [c.get("emotion", "neutral") for c in conditioning]
    postures = [c.get("posture", "neutral") for c in conditioning]
    gestures = [c.get("gesture", "none") for c in conditioning]

    dominant_emotion = _dominant(emotions, "neutral")
    dominant_posture = _dominant(postures, "neutral")
    distinct_gestures = [g for g in dict.fromkeys(gestures) if g and g != "none"]

    parts = [
        f"A person speaking to camera with {EMOTION_PROMPT.get(dominant_emotion, EMOTION_PROMPT['neutral'])}",
        POSTURE_PROMPT.get(dominant_posture, POSTURE_PROMPT["neutral"]),
    ]
    if distinct_gestures:
        gesture_text = ", ".join(GESTURE_PROMPT.get(g, GESTURE_PROMPT["none"]) for g in distinct_gestures[:3])
        parts.append(gesture_text)
    else:
        parts.append(GESTURE_PROMPT["none"])

    intensity = sum(c.get("expression_intensity", 0.4) for c in conditioning) / len(conditioning)
    return {"prompt": ", ".join(parts) + ".", "expression_intensity": intensity}
