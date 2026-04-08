#!/usr/bin/env python3
"""
Voxtral TTS Server — local speech synthesis on Apple Silicon via MLX.
Runs on port 5090. Mammals calls this instead of ElevenLabs.

Usage:
  python3 voxtral_server.py

Endpoints:
  GET /health           — health check
  GET /voices           — list available voices
  GET /tts?text=Hello   — returns WAV audio
  GET /tts?text=Hello&voice=casual_female&temperature=0.6
"""

import io
import sys
import logging
import numpy as np
import soundfile as sf
from flask import Flask, request, send_file, jsonify

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)

app = Flask(__name__)
model = None

DEFAULT_VOICE = "casual_male"
MODEL_ID = "mlx-community/Voxtral-4B-TTS-2603-mlx-4bit"

# Will be populated from model's voice embedding files on load
VOICES = []


def load_model():
    global model, VOICES
    log.info(f"Loading Voxtral model: {MODEL_ID}")
    from mlx_audio.tts.utils import load
    model = load(MODEL_ID)
    # Discover all available voices from embedding files
    if hasattr(model, '_voice_embedding_files'):
        VOICES = sorted(model._voice_embedding_files.keys())
    else:
        VOICES = ["casual_male", "casual_female", "cheerful_female", "neutral_male", "neutral_female"]
    log.info(f"Model loaded. {len(VOICES)} voices available.")


@app.route("/health")
def health():
    return jsonify({"status": "ok", "model": MODEL_ID})


@app.route("/voices")
def voices():
    """List all available voices with metadata."""
    voice_list = []
    for v in VOICES:
        parts = v.rsplit("_", 1)
        if len(parts) == 2:
            lang_or_style, gender = parts
        else:
            lang_or_style, gender = v, "unknown"
        voice_list.append({
            "id": v,
            "name": v.replace("_", " ").title(),
            "gender": gender,
            "style": lang_or_style,
        })
    return jsonify({"voices": voice_list, "default": DEFAULT_VOICE})


@app.route("/tts")
def tts():
    text = request.args.get("text", "").strip()
    voice = request.args.get("voice", DEFAULT_VOICE)
    temperature = float(request.args.get("temperature", 0.8))
    top_k = int(request.args.get("top_k", 50))
    top_p = float(request.args.get("top_p", 0.95))

    if not text:
        return jsonify({"error": "text parameter required"}), 400

    if voice not in VOICES:
        voice = DEFAULT_VOICE

    # Clamp params to sane ranges
    temperature = max(0.1, min(2.0, temperature))
    top_k = max(1, min(200, top_k))
    top_p = max(0.1, min(1.0, top_p))

    log.info(f"TTS: voice={voice} temp={temperature} top_k={top_k} top_p={top_p} text={text[:60]!r}")

    try:
        chunks = []
        for result in model.generate(
            text=text,
            voice=voice,
            temperature=temperature,
            top_k=top_k,
            top_p=top_p,
        ):
            chunks.append(np.array(result.audio))

        audio = np.concatenate(chunks)
        buf = io.BytesIO()
        sf.write(buf, audio, samplerate=24000, format="WAV")
        buf.seek(0)

        return send_file(buf, mimetype="audio/wav", download_name="tts.wav")

    except Exception as e:
        log.error(f"TTS generation failed: {e}")
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    load_model()
    log.info("Voxtral TTS server starting on port 5090")
    app.run(host="0.0.0.0", port=5090, threaded=False)
