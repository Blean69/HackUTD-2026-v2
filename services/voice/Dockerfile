# Keystone voice service (Pipecat). Build context: services/voice. See ../../docs/voice-agent.md and ../../infra/DEPLOY.md.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1

# libgomp1: onnxruntime (Silero VAD); libglib2.0-0: opencv-python-headless (pulled in by aiortc via pipecat's webrtc extra)
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 libglib2.0-0 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

# Host networking in production (WebRTC needs the host's UDP ports), so this is the real listen address, not a published port.
ENV VOICE_HTTP=0.0.0.0:7860
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD python -c "import os,sys,urllib.request as u; p=os.environ.get('VOICE_HTTP','0.0.0.0:7860').rsplit(':',1)[-1]; sys.exit(0 if u.urlopen('http://127.0.0.1:'+p+'/health',timeout=4).status==200 else 1)"

CMD ["python", "server.py"]
